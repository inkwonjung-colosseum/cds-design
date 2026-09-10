import { useEffect, useState } from "react";
import type { ConfluencePageRef, OnboardingStep } from "@cds-design/protocol";
import type { Daemon } from "./daemon-client";

/**
 * First-run wizard (DESIGN §8, reshaped by PLAN M1): Claude Code → git →
 * Confluence → 프로젝트, in that order. The first three are machine-wide and
 * answered once; the fourth is the project — which 기획서 subtree and which
 * repo — and it is the only step that can repeat, because a machine carries
 * as many projects as the planner works on.
 *
 * Each step shows its status, the Korean reason, and either a fix button
 * (daemon-executed) or the inputs the step needs. The workspace opens only
 * when no step FAILS — warns carry their own fix and clear as the wizard
 * completes them. Nothing sensitive is stored in the browser: credentials go
 * straight to the daemon, which files them in the OS store.
 */

const STEP_ORDER = ["claude", "git", "confluence", "project"] as const;

const STEP_TITLE: Record<OnboardingStep["id"], string> = {
  claude: "Claude Code",
  git: "git",
  confluence: "Confluence",
  project: "프로젝트",
};

const STATUS_GLYPH: Record<OnboardingStep["status"], string> = {
  pass: "✓",
  warn: "!",
  fail: "✗",
};

const STATUS_LABEL: Record<OnboardingStep["status"], string> = {
  pass: "통과",
  warn: "주의",
  fail: "실패",
};

export function Onboarding({
  daemon,
  onDone,
}: {
  daemon: Daemon;
  /** Called when every blocking step passed (the tabs may open). */
  onDone: () => void;
}) {
  const steps = daemon.onboarding ?? [];
  const [busy, setBusy] = useState<string | null>(null);
  const [projectName, setProjectName] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [repoPat, setRepoPat] = useState("");
  const [siteUrl, setSiteUrl] = useState("");
  const [email, setEmail] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [space, setSpace] = useState("");
  /** `""` means the whole space; otherwise the id of the subtree's root page. */
  const [rootPageId, setRootPageId] = useState("");
  const [pageTree, setPageTree] = useState<{ pages: ConfluencePageRef[]; taken: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const byId = new Map(steps.map((step) => [step.id, step]));
  const blocked = steps.some((step) => step.status === "fail");
  const busyKind = busy ?? null;
  const hasProject = daemon.projects.length > 0;
  /**
   * Whether the create form is on screen. It always is on a first run; with a
   * project already registered the planner has to ask, so 새 프로젝트 does not
   * sit in the way of a wizard reopened to fix something else.
   */
  const [adding, setAdding] = useState(false);
  const showProjectForm = !hasProject || adding;

  // The check is NOT run here. `Shell` runs it on connect and this wizard is
  // its child, so a second effect meant every gate ran twice per open — two
  // `claude auth status`, two `git ls-remote`, two Confluence round trips —
  // and the second one is what turned a one-response fixture into a failing
  // Confluence gate that nobody could see.

  // A site/email the daemon already stores shows up in the inputs, so a
  // failed check only asks for what is actually missing (usually the token).
  useEffect(() => {
    if (daemon.connection !== "open") return;
    void daemon.api
      .confluenceStatus()
      .then(({ settings }) => {
        setSiteUrl((current) => current || settings.siteUrl || "");
        setEmail((current) => current || settings.email || "");
      })
      .catch(() => undefined);
  }, [daemon.connection]);

  // The root picker reads Confluence directly — nothing is mirrored until a
  // project exists. Changing the space invalidates whatever root was chosen
  // under the previous one.
  useEffect(() => {
    setRootPageId("");
    setPageTree(null);
    if (!space) return;
    let live = true;
    void daemon.api
      .confluencePageTree(space)
      .then((tree) => {
        if (live) setPageTree({ pages: tree.pages, taken: tree.taken });
      })
      .catch((e: Error) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [space]);

  const run = async (label: string, action: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await action();
      await daemon.api.onboardingCheck();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="onboarding">
      <header className="onboarding__head">
        <h1>CDS Design 시작하기</h1>
        <p className="hint">
          앞의 세 단계는 이 컴퓨터에서 한 번만 확인하면 됩니다. 마지막 프로젝트 단계에서 기획서가 있는
          Confluence 위치와 화면을 만들 레포를 정하면 작업 화면이 열립니다.
        </p>
      </header>

      {steps.length === 0 && !error && <p className="hint">단계를 확인하는 중…</p>}
      {error && (
        <div className="notice notice--error">
          <span className="notice__text">{error}</span>
        </div>
      )}

      <ol className="onboarding__steps">
        {STEP_ORDER.map((id) => {
          const step = byId.get(id);
          if (!step) return null;
          return (
            <li key={id} className={`onboarding__step onboarding__step--${step.status}`}>
              <div className="onboarding__stephead">
                <span className={`onboarding__glyph onboarding__glyph--${step.status}`}>
                  {STATUS_GLYPH[step.status]}
                </span>
                <span className="onboarding__stepnum">{STEP_ORDER.indexOf(id) + 1}</span>
                <h2>{STEP_TITLE[id]}</h2>
                <span className={`onboarding__status onboarding__status--${step.status}`}>
                  {STATUS_LABEL[step.status]}
                </span>
              </div>
              <p className="onboarding__detail">{step.detail}</p>

              {/* The form's Confluence location comes from the step above it,
                  so offering it before that step passes hands the planner an
                  empty dropdown and no reason for it. */}
              {id === "project" && showProjectForm && byId.get("confluence")?.status !== "pass" && (
                <p className="hint">먼저 위의 Confluence 연결을 마쳐 주세요.</p>
              )}
              {/* A planner who already has one project reaches this wizard
                  through 새 프로젝트 in the switcher; without this the registry
                  was write-once and multi-project support was unreachable. */}
              {id === "project" && hasProject && !adding && (
                <div className="onboarding__fixrow">
                  <button type="button" className="ghost" onClick={() => setAdding(true)}>
                    + 새 프로젝트
                  </button>
                </div>
              )}
              {id === "project" && showProjectForm && byId.get("confluence")?.status === "pass" && (
                <div className="onboarding__inputs">
                  <input
                    value={projectName}
                    placeholder="프로젝트 이름 (예: 결제)"
                    aria-label="프로젝트 이름"
                    onChange={(e) => setProjectName(e.target.value)}
                  />
                  <select
                    aria-label="기획서가 있는 스페이스"
                    value={space}
                    onChange={(e) => setSpace(e.target.value)}
                  >
                    <option value="">스페이스 선택…</option>
                    {(byId.get("confluence")?.spaces ?? []).map((entry) => (
                      <option key={entry.id} value={entry.key}>
                        {entry.key} · {entry.name}
                      </option>
                    ))}
                  </select>
                  {space && (
                    <select
                      aria-label="기획서가 있는 상위 페이지"
                      value={rootPageId}
                      disabled={pageTree === null}
                      onChange={(e) => setRootPageId(e.target.value)}
                    >
                      <option value="">
                        {pageTree === null ? "페이지를 불러오는 중…" : "스페이스 전체"}
                      </option>
                      {indentedPages(pageTree?.pages ?? [], pageTree?.taken ?? []).map(
                        ({ page, depth, taken }) => (
                          <option key={page.id} value={page.id} disabled={taken}>
                            {"\u00a0".repeat(depth * 2)}
                            {page.title}
                            {taken ? " (다른 프로젝트가 사용 중)" : ""}
                          </option>
                        ),
                      )}
                    </select>
                  )}
                  <input
                    value={repoUrl}
                    spellCheck={false}
                    placeholder="https://github.com/<조직>/<레포>.git"
                    aria-label="연결 레포 주소"
                    onChange={(e) => setRepoUrl(e.target.value)}
                  />
                  <input
                    type="password"
                    value={repoPat}
                    placeholder="개인 액세스 토큰(선택)"
                    aria-label="연결 레포 개인 액세스 토큰"
                    onChange={(e) => setRepoPat(e.target.value)}
                  />
                  <button
                    type="button"
                    className="primary"
                    disabled={!projectName.trim() || !space || !repoUrl.trim() || busyKind !== null}
                    onClick={() =>
                      void run("project-create", () =>
                        daemon.api.projectCreate({
                          name: projectName.trim(),
                          roots: [{ space, rootPageId: rootPageId || null }],
                          repoUrl: repoUrl.trim(),
                          ...(repoPat.trim() ? { repoPat: repoPat.trim() } : {}),
                        }),
                      )
                    }
                  >
                    {busyKind === "project-create" ? "만드는 중…" : "프로젝트 만들기"}
                  </button>
                  <p className="hint">
                    기획서를 복제하고 레포를 내려받아 설치까지 합니다 — 처음에는 몇 분 걸립니다.
                  </p>
                </div>
              )}

              {id === "project" && hasProject && step.status !== "pass" && (
                <div className="onboarding__inputs">
                  <input
                    value={repoUrl}
                    spellCheck={false}
                    placeholder="https://github.com/<조직>/<레포>.git"
                    aria-label="연결 레포 주소"
                    onChange={(e) => setRepoUrl(e.target.value)}
                  />
                  <input
                    type="password"
                    value={repoPat}
                    placeholder="개인 액세스 토큰(선택)"
                    aria-label="연결 레포 개인 액세스 토큰"
                    onChange={(e) => setRepoPat(e.target.value)}
                  />
                  <button
                    type="button"
                    className="primary"
                    disabled={!repoUrl.trim() || busyKind !== null || !daemon.activeSlug}
                    onClick={() =>
                      void run("repo-credentials", () =>
                        daemon.api.projectUpdate(daemon.activeSlug!, {
                          repoUrl: repoUrl.trim(),
                          ...(repoPat.trim() ? { repoPat: repoPat.trim() } : {}),
                        }),
                      )
                    }
                  >
                    {busyKind === "repo-credentials" ? "저장 중…" : "주소 저장"}
                  </button>
                </div>
              )}

              {id === "confluence" && step.status !== "pass" && (
                <div className="onboarding__inputs">
                  <input
                    value={siteUrl}
                    spellCheck={false}
                    placeholder="https://<사이트>.atlassian.net"
                    aria-label="Confluence 사이트 주소"
                    onChange={(e) => setSiteUrl(e.target.value)}
                  />
                  <input
                    value={email}
                    spellCheck={false}
                    placeholder="이메일"
                    aria-label="Confluence 이메일"
                    onChange={(e) => setEmail(e.target.value)}
                  />
                  <input
                    type="password"
                    value={apiToken}
                    placeholder="API 토큰"
                    aria-label="Confluence API 토큰"
                    onChange={(e) => setApiToken(e.target.value)}
                  />
                  <button
                    type="button"
                    className="primary"
                    disabled={!siteUrl.trim() || !email.trim() || !apiToken.trim() || busyKind !== null}
                    onClick={() =>
                      void run("confluence-credentials", () =>
                        daemon.api.confluenceUpdate(siteUrl.trim(), email.trim(), apiToken),
                      )
                    }
                  >
                    {busyKind === "confluence-credentials" ? "확인 중…" : "연결 확인"}
                  </button>
                </div>
              )}

              {step.fix && step.status !== "pass" && (
                <div className="onboarding__fixrow">
                  <button
                    type="button"
                    className="primary"
                    disabled={busyKind !== null}
                    onClick={() =>
                      // The project owns which Confluence location it mirrors,
                      // so a `confluence-sync` fix no longer needs a space
                      // named here: the daemon clones what the project declares.
                      void run(step.fix!.kind, () => daemon.api.onboardingFix(step.fix!.kind))
                    }
                  >
                    {busyKind === step.fix.kind ? "실행 중…" : step.fix.label}
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ol>

      {!blocked && steps.length > 0 && (
        <div className="onboarding__done">
          <button type="button" className="primary" onClick={onDone}>
            시작하기
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The remote page list, flattened into picker rows with their depth and
 * whether they are off limits.
 *
 * Confluence hands back a flat list with `parentId`; the planner has to
 * recognise "결제 서비스" by where it sits, so the rows are ordered
 * parent-then-children and indented. A page whose parent is not in the list
 * (permissions, a listing cut short) becomes a top-level row rather than
 * disappearing — a page shown flat beats a page the planner cannot find.
 *
 * `taken` is what the daemon reports as already owned: every project root in
 * this space plus its ancestors. Descendants of a root are off limits too and
 * the daemon cannot enumerate them cheaply, so that half is decided here,
 * where the tree is: once a row is taken, everything under it is.
 */
function indentedPages(
  pages: readonly ConfluencePageRef[],
  taken: readonly string[],
): Array<{ page: ConfluencePageRef; depth: number; taken: boolean }> {
  const children = new Map<string | null, ConfluencePageRef[]>();
  const known = new Set(pages.map((page) => page.id));
  for (const page of pages) {
    const key = page.parentId && known.has(page.parentId) ? page.parentId : null;
    const bucket = children.get(key);
    if (bucket) bucket.push(page);
    else children.set(key, [page]);
  }

  const owned = new Set(taken);
  const rows: Array<{ page: ConfluencePageRef; depth: number; taken: boolean }> = [];
  const walk = (parentId: string | null, depth: number, inherited: boolean) => {
    for (const page of children.get(parentId) ?? []) {
      const blocked = inherited || owned.has(page.id);
      rows.push({ page, depth, taken: blocked });
      walk(page.id, depth + 1, blocked);
    }
  };
  walk(null, 0, false);
  return rows;
}
