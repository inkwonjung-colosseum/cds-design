/**
 * Onboarding (DESIGN §8, reshaped by PLAN M1): the gates a first run has to
 * pass before the workspace opens.
 *
 * Three of them are machine-wide and answered once — Claude Code, git, the
 * Confluence site. The fourth is the project: which 기획서 subtree and which
 * repo this planner is working on. The connected repo used to be a gate of its
 * own; it is now part of the project, because a machine can carry several and
 * "the repo" only means something once a project says which.
 *
 * Gate semantics: `fail` blocks; `warn` (API-key shadowing, a project whose
 * repo is configured and reachable but not cloned yet) shows its reason and
 * fix without blocking — those complete through the wizard's own actions.
 */

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readClaudeVersion, readAuthStatus, resolveClaudeExecutable } from "./environment.js";
import { authenticatedUrl, redact } from "./repo.js";
import { parseRepoSlug, type GitHubClient } from "./github.js";
import type { ConfluenceClient } from "./sync/confluence-client.js";
import type { SyncEngine } from "./sync/sync-engine.js";
import type { RepoWorkspace } from "./repo.js";

const run = promisify(execFile);

export type OnboardingStepId = "claude" | "git" | "confluence" | "project";
export type OnboardingStatus = "pass" | "warn" | "fail";
export type OnboardingFixKind =
  | "install-claude"
  | "login-claude"
  | "install-git"
  | "repo-install"
  | "confluence-sync";

export interface OnboardingFix {
  kind: OnboardingFixKind;
  label: string;
}

export interface OnboardingStep {
  id: OnboardingStepId;
  status: OnboardingStatus;
  detail: string;
  fix?: OnboardingFix;
  /** Confluence only: the spaces the credentials can see, for the pick UI. */
  spaces?: Array<{ id: string; key: string; name: string }>;
}

export interface OnboardingDeps {
  claudeExecutableOverride?: string;
  /**
   * The active project's workspaces, or null when no project exists yet —
   * which is exactly what the project gate reports and the wizard fixes.
   */
  repo: RepoWorkspace | null;
  confluence: SyncEngine | null;
  /** The active project's name, for a passing gate to say which one. */
  projectName?: string | null;
  confluenceClient: () => ConfluenceClient | null;
  /**
   * The active project's GitHub client, or null (no token, not GitHub, or a
   * caller that does not care). Absent means the PAT-scope probe is skipped,
   * never that it failed.
   */
  gitHubClient?: () => GitHubClient | null;
}

export async function runOnboardingChecks(deps: OnboardingDeps): Promise<OnboardingStep[]> {
  return [
    await checkClaude(deps),
    await checkGit(deps),
    await checkConfluence(deps),
    await checkProject(deps),
  ];
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

async function checkClaude(deps: OnboardingDeps): Promise<OnboardingStep> {
  const executable = await resolveClaudeExecutable(deps.claudeExecutableOverride);
  if (!executable) {
    return fail(
      "claude",
      "Claude Code CLI를 찾지 못했습니다.",
      { kind: "install-claude", label: "Claude Code 설치" },
    );
  }
  const auth = await readAuthStatus(executable);
  if (!auth.loggedIn) {
    return fail(
      "claude",
      "Claude Code 로그인이 필요합니다 — 본인 구독으로 실행됩니다.",
      { kind: "login-claude", label: "Claude Code 로그인" },
    );
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      id: "claude",
      status: "warn",
      detail:
        "ANTHROPIC_API_KEY 환경변수가 설정되어 있어 구독 대신 이 키로 결제됩니다. 데몬 환경에서 키를 제거하고 다시 시작해 주세요.",
    };
  }
  const version = await readClaudeVersion(executable);
  const plan = auth.subscriptionType ? ` · ${auth.subscriptionType}` : "";
  return pass("claude", `Claude Code 준비됨${version ? ` (${version})` : ""}${plan}`);
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

async function checkGit(deps: OnboardingDeps): Promise<OnboardingStep> {
  try {
    const { stdout } = await run("git", ["--version"]);
    return pass("git", `git 준비됨 (${stdout.trim()})`);
  } catch {
    const detail =
      process.platform === "darwin"
        ? "git이 없습니다 — Xcode 명령줄 도구를 설치해 주세요. 터미널에 xcode-select --install 을 실행하면 설치 창이 열립니다."
        : "git이 없습니다 — git을 설치한 뒤 다시 확인해 주세요.";
    return fail("git", detail, { kind: "install-git", label: "설치 안내 보기" });
  }
}

// ---------------------------------------------------------------------------
// Project (the 기획서 subtree + the connected repo it builds)
// ---------------------------------------------------------------------------

async function checkProject(deps: OnboardingDeps): Promise<OnboardingStep> {
  const repo = deps.repo;
  if (!repo) {
    // No fix button: creating a project needs a name, a Confluence location
    // and a repo url, so the wizard's own form is the fix.
    return fail(
      "project",
      "프로젝트가 없습니다 — 기획서가 있는 Confluence 위치와 연결 레포를 정해 프로젝트를 만들어 주세요.",
    );
  }
  const url = repo.remoteUrl;
  if (!url) {
    return fail(
      "project",
      "연결 레포 주소가 설정되지 않았습니다 — 주소와 필요하면 PAT를 입력해 주세요.",
      { kind: "repo-install", label: "복제하고 설치" },
    );
  }

  // Authentication and reachability, without touching the clone.
  const pat = repo.currentPat();
  try {
    await run("git", ["ls-remote", authenticatedUrl(url, pat), "HEAD"], {
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    // git quotes the authenticated remote url in its errors; the PAT that
    // rode inside it must not reach the step detail the planner reads.
    const output = redact(error instanceof Error ? error.message : String(error), pat);
    const authHint = /Authentication failed|could not read Username|403|Permission denied/i.test(output)
      ? " 접근 권한이 없습니다 — 비공개 레포라면 PAT를 확인해 주세요."
      : "";
    return fail(
      "project",
      `연결 레포에 접근하지 못했습니다.${authHint} (${firstLine(output)})`,
      { kind: "repo-install", label: "다시 시도" },
    );
  }

  const config = repo.drafthouse();
  if (repo.isCloned() && !config) {
    return fail(
      "project",
      "레포의 drafthouse.json을 읽을 수 없습니다 — 루트에 올바른 drafthouse.json이 있어야 합니다.",
      { kind: "repo-install", label: "다시 시도" },
    );
  }

  if (!repo.isCloned() || !repo.installUpToDate()) {
    return {
      id: "project",
      status: "warn",
      detail: repo.isCloned() ? "의존성 설치가 필요합니다." : "연결 레포를 복제하고 설치해야 합니다.",
      fix: { kind: "repo-install", label: "복제하고 설치" },
    };
  }

  // A project with no mirrored 기획서 has nothing to build a screen from, and
  // the planner cannot tell that from a repo-shaped message.
  const mirrored = deps.confluence?.spaces() ?? [];
  if (mirrored.length === 0) {
    return {
      id: "project",
      status: "warn",
      detail: "기획서 미러가 비어 있습니다 — 이 프로젝트의 Confluence 위치를 복제해 주세요.",
      fix: { kind: "confluence-sync", label: "기획서 복제" },
    };
  }

  // Cloning needs read; 개발자에게 넘기기 needs write. A token that can only
  // read fails at the last step of the whole pipeline, after the planner has
  // done all the work — so it is checked here, at the start.
  const slug = parseRepoSlug(url);
  const github = slug ? deps.gitHubClient?.() : null;
  if (slug && github) {
    const access = await github.verifyPullRequestAccess(slug);
    if (!access.ok) {
      return {
        id: "project",
        status: "warn",
        detail: access.detail ?? "이 토큰으로는 개발자에게 넘길 수 없습니다.",
      };
    }
  }

  return pass("project", `${deps.projectName ?? "프로젝트"} 준비됨 — ${url}`);
}

function firstLine(text: string): string {
  return (text.split("\n").find((line) => line.trim() !== "") ?? text).slice(0, 160);
}

// ---------------------------------------------------------------------------
// Confluence
// ---------------------------------------------------------------------------

async function checkConfluence(deps: OnboardingDeps): Promise<OnboardingStep> {
  const client = deps.confluenceClient();
  if (!client) {
    return fail(
      "confluence",
      "Confluence 연결 정보가 설정되지 않았습니다 — 사이트 주소, 이메일, API 토큰을 입력해 주세요.",
      { kind: "confluence-sync", label: "다시 시도" },
    );
  }
  let spaces: Array<{ id: string; key: string; name: string }>;
  try {
    spaces = await client.listSpaces(100);
  } catch (error) {
    return fail(
      "confluence",
      `Confluence에 접속하지 못했습니다 (${firstLine(error instanceof Error ? error.message : String(error))})`,
      { kind: "confluence-sync", label: "다시 시도" },
    );
  }

  // Mirroring belongs to a project now, not to this machine-wide gate: the
  // credentials either reach the site or they do not. The list still rides
  // along — the project wizard's location picker starts from it.
  return {
    id: "confluence",
    status: "pass",
    detail: `Confluence 준비됨 — 스페이스 ${spaces.length}개 접근 가능`,
    spaces,
  };
}

// ---------------------------------------------------------------------------
// Fix helpers the server calls
// ---------------------------------------------------------------------------

/** The spawn surface the fix flows use — injectable in tests. */
export type SpawnLike = typeof spawn;

/** A spawned child nobody waits for: errors are absorbed, never unhandled. */
function detach(child: ReturnType<SpawnLike>): void {
  // A detached ENOENT surfaces as an async 'error' event; without a listener
  // it would crash the daemon. Nobody reads the outcome here — the planner
  // re-runs the check — so absorbing is the whole job.
  child.once("error", () => undefined);
  child.unref();
}

const INSTALL_FAILED =
  "설치를 시작하지 못했습니다 — 터미널에서 curl -fsSL https://claude.ai/install.sh | bash 를 직접 실행해 주세요.";
const LOGIN_FAILED =
  "로그인 창을 열지 못했습니다 — 터미널에서 claude /login 을 직접 실행해 주세요.";

/** Runs the Claude Code native installer detached; progress is its own output. */
export function startClaudeInstall(
  spawnLike: SpawnLike = spawn,
): { started: boolean; guidance: string } {
  try {
    detach(spawnLike("sh", ["-c", "curl -fsSL https://claude.ai/install.sh | bash"], {
      detached: true,
      stdio: "ignore",
    }));
    return {
      started: true,
      guidance: "설치를 시작했습니다 — 몇 분 뒤 이 단계를 다시 확인해 주세요.",
    };
  } catch {
    return { started: false, guidance: INSTALL_FAILED };
  }
}

/** Opens a Terminal window running `claude /login` (macOS), else spawns it. */
export function startClaudeLogin(
  spawnLike: SpawnLike = spawn,
): { started: boolean; guidance: string } {
  if (process.platform === "darwin") {
    try {
      detach(spawnLike("osascript", ["-e", 'tell application "Terminal" to do script "claude /login"'], {
        detached: true,
        stdio: "ignore",
      }));
      return {
        started: true,
        guidance: "터미널 창을 열었습니다 — 브라우저 로그인을 마친 뒤 이 단계를 다시 확인해 주세요.",
      };
    } catch {
      // fall through to the detached spawn
    }
  }
  try {
    // Windows: `claude` is a .cmd shim, which is not an executable — a shell
    // resolves it. Everywhere else the direct spawn is one process fewer.
    detach(spawnLike("claude", ["/login"], {
      detached: true,
      stdio: "ignore",
      shell: process.platform === "win32",
    }));
    return {
      started: true,
      guidance: "로그인 절차를 시작했습니다 — 안내를 따라 로그인한 뒤 이 단계를 다시 확인해 주세요.",
    };
  } catch {
    return { started: false, guidance: LOGIN_FAILED };
  }
}

/** The CLT guidance is surfaced, not executed: it opens a system installer. */
export function gitInstallGuidance(): { command: string; guidance: string } {
  return {
    command: "xcode-select --install",
    guidance: "터미널에 위 명령을 실행하면 Xcode 명령줄 도구 설치 창이 열립니다. 설치 후 다시 확인해 주세요.",
  };
}

function pass(id: OnboardingStepId, detail: string): OnboardingStep {
  return { id, status: "pass", detail };
}

/** A gate with no `fix` is one only the planner's own input can clear. */
function fail(id: OnboardingStepId, detail: string, fix?: OnboardingFix): OnboardingStep {
  return { id, status: "fail", detail, ...(fix ? { fix } : {}) };
}
