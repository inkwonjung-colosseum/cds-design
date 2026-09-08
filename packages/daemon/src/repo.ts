import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { get as httpGet } from "node:http";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { RepoPhase, RepoStatus } from "@agent-hub/protocol";
import {
  HUB_DIR,
  currentPlatform,
  detectsRegistryAuthFailure,
  resolvePnpmExecutable,
} from "./environment.js";

/**
 * The connected repo workspace: a clone of the repo the planner pointed the
 * daemon at, driven by that repo's own `drafthouse.json` (install/check/build
 * commands, preview command + port, optional private registry). The daemon
 * clones and pulls it, runs its commands, and frames its preview server —
 * what the preview renders is entirely the repo's business.
 */

const CONFIG_FILE = "drafthouse.json";
/** Reinstall marker, kept inside `.git/` so it travels with the clone only. */
const INSTALL_MARKER = "drafthouse-install-hash";
const READY_TIMEOUT_MS = 30_000;
const DETAIL_THROTTLE_MS = 200;

export const PNPM_MISSING_DETAIL =
  "pnpm이 없습니다 — corepack enable 또는 npm i -g pnpm 으로 설치해 주세요.";
export const REGISTRY_AUTH_DETAIL =
  "GitHub 패키지 인증이 필요합니다 — pnpm config set //npm.pkg.github.com/:_authToken <read:packages 권한 PAT>";
export const REPO_URL_MISSING_DETAIL =
  "연결 레포 주소가 설정되지 않았습니다 — 설정에서 레포 주소를 넣어 주세요.";

export interface RepoConfig {
  /** Absolute path of the clone. */
  root: string;
  /** Remote url from the environment; wins over the stored settings (tests). */
  url: string | null;
}

/**
 * The paths every part of the system agrees on. `AGENT_HUB_REPO_URL` exists
 * so the daemon e2e can drive this code against a local fixture remote.
 */
export function resolveRepoConfig(env: NodeJS.ProcessEnv = process.env): RepoConfig {
  return {
    root: env.AGENT_HUB_REPO_DIR ?? join(homedir(), "drafthouse", "repo"),
    url: env.AGENT_HUB_REPO_URL ?? null,
  };
}

// ---------------------------------------------------------------------------
// Stored repo settings (url + PAT)
// ---------------------------------------------------------------------------

interface RepoSettings {
  url: string | null;
  pat: string | null;
}

/** `AGENT_HUB_REPO_SETTINGS` points the e2e at a throwaway file. */
function settingsFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENT_HUB_REPO_SETTINGS ?? join(HUB_DIR, "repo.json");
}

export function loadRepoSettings(env: NodeJS.ProcessEnv = process.env): RepoSettings {
  try {
    const parsed = JSON.parse(readFileSync(settingsFile(env), "utf8")) as Partial<RepoSettings>;
    return {
      url: typeof parsed.url === "string" ? parsed.url : null,
      pat: typeof parsed.pat === "string" ? parsed.pat : null,
    };
  } catch {
    return { url: null, pat: null };
  }
}

function saveRepoSettings(settings: RepoSettings, env: NodeJS.ProcessEnv = process.env): void {
  const file = settingsFile(env);
  mkdirSync(dirname(file), { recursive: true });
  // The PAT lands in this file; write it in one step at a private mode so it
  // is never half written or world readable.
  const temporary = `${file}.agent-hub-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

// ---------------------------------------------------------------------------
// drafthouse.json contract
// ---------------------------------------------------------------------------

export interface DrafthouseRegistry {
  host: string;
  scope: string;
}

export interface DrafthouseConfig {
  install?: string;
  check?: string;
  build?: string;
  preview: { command: string; port: number };
  registry?: DrafthouseRegistry;
}

/**
 * Parses and validates a repo's `drafthouse.json`. Every rejection names the
 * field and what it should be, in Korean: the planner is the one who has to
 * act on it, and "invalid config" is not actionable.
 */
export function parseDrafthouseConfig(source: string): DrafthouseConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch (error) {
    throw new Error(
      `drafthouse.json을 해석할 수 없습니다: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("drafthouse.json은 객체여야 합니다");
  }
  const config = raw as Record<string, unknown>;

  for (const key of ["install", "check", "build"] as const) {
    const value = config[key];
    if (value !== undefined && (typeof value !== "string" || value.trim() === "")) {
      throw new Error(`drafthouse.json의 ${key}는 실행할 명령을 문자열로 적어야 합니다`);
    }
  }

  const preview = config.preview;
  if (!preview || typeof preview !== "object" || Array.isArray(preview)) {
    throw new Error('drafthouse.json에 preview가 없습니다 — { "command", "port" }를 적어야 합니다');
  }
  const { command, port } = preview as Record<string, unknown>;
  if (typeof command !== "string" || command.trim() === "") {
    throw new Error("drafthouse.json의 preview.command가 없습니다 — 미리보기를 띄울 명령입니다");
  }
  if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) {
    throw new Error(
      "drafthouse.json의 preview.port가 잘못되었습니다 — 1~65535 사이의 포트 번호여야 합니다",
    );
  }

  const rawRegistry = config.registry;
  if (rawRegistry === undefined) {
    return {
      ...(typeof config.install === "string" ? { install: config.install } : {}),
      ...(typeof config.check === "string" ? { check: config.check } : {}),
      ...(typeof config.build === "string" ? { build: config.build } : {}),
      preview: { command, port: port as number },
    };
  }
  const registry = rawRegistry as Record<string, unknown>;
  if (
    typeof registry.host !== "string" ||
    registry.host.trim() === "" ||
    typeof registry.scope !== "string" ||
    registry.scope.trim() === ""
  ) {
    throw new Error('drafthouse.json의 registry는 { "host", "scope" } 형태여야 합니다');
  }

  return {
    ...(typeof config.install === "string" ? { install: config.install } : {}),
    ...(typeof config.check === "string" ? { check: config.check } : {}),
    ...(typeof config.build === "string" ? { build: config.build } : {}),
    preview: { command, port: port as number },
    registry: { host: registry.host, scope: registry.scope },
  };
}

export function readDrafthouseConfig(root: string): DrafthouseConfig {
  const file = join(root, CONFIG_FILE);
  if (!existsSync(file)) {
    throw new Error(`drafthouse.json이 없습니다 — 연결 레포 루트에 ${CONFIG_FILE}가 있어야 합니다`);
  }
  return parseDrafthouseConfig(readFileSync(file, "utf8"));
}

// ---------------------------------------------------------------------------
// Credential helpers (pure, unit tested)
// ---------------------------------------------------------------------------

/** Embeds a PAT in an https url the way git accepts it; other schemes pass through. */
export function authenticatedUrl(url: string, pat: string | null): string {
  if (!pat || !url.startsWith("https://")) return url;
  return `https://${pat}@${url.slice("https://".length)}`;
}

/** git error output quotes the remote url; the PAT must never survive that. */
function redact(text: string, secret: string | null): string {
  return secret ? text.split(secret).join("***") : text;
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

export class RepoWorkspace {
  readonly root: string;

  private url: string | null;
  private pat: string | null;
  private phase: RepoPhase = "missing";
  private detail: string | null = null;
  private config: DrafthouseConfig | null = null;
  private preview: ChildProcess | null = null;
  private inFlight: Promise<RepoStatus> | null = null;
  private lastEmit = 0;

  private readonly onStatus: (status: RepoStatus) => void;

  constructor(
    options: RepoConfig & {
      onStatus: (status: RepoStatus) => void;
      /** PAT from stored settings; the env url wins over the stored url. */
      pat?: string | null;
    },
  ) {
    this.root = options.root;
    this.url = options.url;
    this.pat = options.pat ?? null;
    this.onStatus = options.onStatus;
  }

  get remoteUrl(): string | null {
    return this.url;
  }

  get patConfigured(): boolean {
    return this.pat !== null;
  }

  /** The repo's declared private registry, once its drafthouse.json was read. */
  registry(): DrafthouseRegistry | null {
    return this.config?.registry ?? null;
  }

  /** Disk state only; safe to call from any client at any time. */
  async status(): Promise<RepoStatus> {
    if (this.isCloned()) {
      try {
        this.config = readDrafthouseConfig(this.root);
      } catch {
        // Keep the last known config; the working phases surface parse errors.
      }
    }
    return this.snapshot();
  }

  sync(): Promise<RepoStatus> {
    if (!this.inFlight) {
      this.inFlight = this.bootstrap().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  /**
   * Set the url and/or PAT, persist both daemon-side, and bring the workspace
   * to the resulting state: a moved url means a different repository, so the
   * old clone is discarded and re-cloned.
   */
  async update(changes: { url?: string | null; pat?: string | null }): Promise<RepoStatus> {
    // Absent keys stay unchanged; `null` clears. The PAT arrives write-only,
    // so it is persisted immediately and never leaves this process again.
    const urlChanged = changes.url !== undefined && changes.url !== this.url;
    if (changes.url !== undefined) this.url = changes.url;
    if (changes.pat !== undefined) this.pat = changes.pat;
    saveRepoSettings({ url: this.url, pat: this.pat });

    if (!this.url) {
      await this.stop();
      this.setPhase("missing", REPO_URL_MISSING_DETAIL);
      return this.snapshot();
    }

    if (urlChanged) {
      await this.stop();
      rmSync(this.root, { recursive: true, force: true });
    } else if (this.isCloned()) {
      // A PAT added later has to reach pulls too; clone already embedded it.
      await this.git(["remote", "set-url", "origin", authenticatedUrl(this.url, this.pat)]);
    }
    return await this.sync();
  }

  /**
   * Session-start pull: bring an already-working clone current without
   * tearing its preview down. A failed pull stays a `detail` — hiding a live
   * preview mid-conversation is worse than being a commit behind until the
   * next sync() reports the failure properly.
   */
  async pull(): Promise<void> {
    if (this.phase !== "ready" || !this.isCloned()) return;
    try {
      await this.git(["pull", "--ff-only"]);
      if (this.dependenciesMoved()) await this.sync();
    } catch (error) {
      this.setDetail(detailOf(error, this.pat));
    }
  }

  async stop(): Promise<void> {
    await this.killPreview();
  }

  // -------------------------------------------------------------------------
  // Bootstrap
  // -------------------------------------------------------------------------

  private async bootstrap(): Promise<RepoStatus> {
    try {
      if (!this.url) {
        this.setPhase("missing", REPO_URL_MISSING_DETAIL);
        return this.snapshot();
      }

      if (!this.isCloned()) {
        await this.killPreview();
        this.setPhase("cloning", null);
        await this.git(
          ["clone", authenticatedUrl(this.url, this.pat), this.root],
          dirname(this.root),
        );
        trustWorkspace(this.root);
      } else {
        this.setPhase("pulling", null);
        await this.git(["pull", "--ff-only"]);
      }

      const config = readDrafthouseConfig(this.root);
      this.config = config;
      const installed = await this.installIfNeeded(config);

      // Up to date and still serving: restarting the preview would only flip
      // the UI out of `ready` for no gain.
      if (!installed && this.preview && (await this.isServing(config.preview.port))) {
        this.setPhase("ready", null);
        return this.snapshot();
      }
      await this.startPreview(config);
      this.setPhase("ready", null);
    } catch (error) {
      this.setPhase("error", detailOf(error, this.pat));
    }
    return this.snapshot();
  }

  private isCloned(): boolean {
    return existsSync(join(this.root, ".git"));
  }

  // -------------------------------------------------------------------------
  // Command runner (install/check/build)
  // -------------------------------------------------------------------------

  /**
   * Runs `install` only when the dependency set moved or the clone is fresh.
   * The identity is a content hash of the manifest and lockfiles, recorded
   * inside `.git/` so it belongs to this clone alone.
   */
  private async installIfNeeded(config: DrafthouseConfig): Promise<boolean> {
    if (!config.install) return false;
    if (!this.dependenciesMoved()) return false;

    this.setPhase("installing", null);
    // The repo declares its private registry; the daemon holds the PAT, and
    // package managers read their credentials from .npmrc.
    if (config.registry && this.pat) this.writeNpmrc(config.registry);
    await this.runCommand(config.install, "install");
    writeFileSync(join(this.root, ".git", INSTALL_MARKER), this.dependencyHash());
    return true;
  }

  private dependencyHash(): string {
    return dependencyHash(this.root);
  }

  private dependenciesMoved(): boolean {
    const marker = join(this.root, ".git", INSTALL_MARKER);
    if (!existsSync(marker)) return true;
    try {
      return readFileSync(marker, "utf8") !== this.dependencyHash();
    } catch {
      return true;
    }
  }

  private writeNpmrc(registry: DrafthouseRegistry): void {
    const scope = registry.scope.startsWith("@") ? registry.scope : `@${registry.scope}`;
    const lines = [
      `${scope}:registry=https://${registry.host}/`,
      `//${registry.host}/:_authToken=${this.pat}`,
    ];
    writeFileSync(join(this.root, ".npmrc"), `${lines.join("\n")}\n`, { mode: 0o600 });
  }

  private async runCommand(command: string, label: string): Promise<void> {
    await this.requirePnpmIfReferenced(command);
    const result = await this.capture(command, this.spawnOptions());
    if (result.code === 0) return;
    if (detectsRegistryAuthFailure(result.output)) throw new Error(REGISTRY_AUTH_DETAIL);
    throw new Error(
      redact(`${label} 명령이 실패했습니다 (exit ${result.code}): ${result.lastLine}`, this.pat),
    );
  }

  /** A drafthouse command may or may not need pnpm; only demand it when it does. */
  private async requirePnpmIfReferenced(command: string): Promise<void> {
    if (!/\bpnpm\b/.test(command)) return;
    if (!(await resolvePnpmExecutable())) throw new Error(PNPM_MISSING_DETAIL);
  }

  // -------------------------------------------------------------------------
  // Preview server
  // -------------------------------------------------------------------------

  private async startPreview(config: DrafthouseConfig): Promise<void> {
    await this.killPreview();
    this.setPhase("starting", null);
    const { command, port } = config.preview;
    await this.requirePnpmIfReferenced(command);

    const child = spawn(command, this.spawnOptions());
    this.preview = child;
    const absorb = (chunk: Buffer) => {
      const line = String(chunk).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop();
      if (line) this.setDetail(line);
    };
    child.stdout?.on("data", absorb);
    child.stderr?.on("data", absorb);

    child.once("exit", (code, signal) => {
      if (this.preview !== child) return; // stop() already took it down
      this.preview = null;
      this.setPhase(
        "error",
        `미리보기 서버가 종료되었습니다 (${signal ? `signal ${signal}` : `exit ${code}`})`,
      );
    });

    await this.waitReady(port);
  }

  private spawnOptions(): SpawnOptions {
    const windows = currentPlatform() === "win32";
    return {
      cwd: this.root,
      // drafthouse.json commands are strings ("pnpm dev"), so a shell parses
      // them. `detached` on POSIX puts the tree in one process group we can
      // signal together when the preview must stop.
      shell: true,
      detached: !windows,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        // The preview must never inherit a key that would bill API credit.
        ANTHROPIC_API_KEY: undefined,
      },
    };
  }

  private async waitReady(port: number): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!this.preview) throw new Error(this.detail ?? "미리보기 서버가 시작되지 않았습니다");
      if (await this.isServing(port)) return;
      await sleep(250);
    }
    throw new Error(
      `미리보기 서버가 ${READY_TIMEOUT_MS / 1000}초 안에 응답하지 않았습니다 (포트 ${port})`,
    );
  }

  /** Ready means the port is open *and* the app answers, not just listening. */
  private async isServing(port: number): Promise<boolean> {
    if (!(await portAccepts(port))) return false;
    return await respondsOk(`http://127.0.0.1:${port}/`);
  }

  private async killPreview(): Promise<void> {
    const child = this.preview;
    if (!child) return;
    this.preview = null;

    const { promise: exited, resolve } = Promise.withResolvers<void>();
    child.once("exit", () => resolve());
    killTree(child, "SIGTERM");
    const hard = setTimeout(() => killTree(child, "SIGKILL"), 3_000);
    await exited;
    clearTimeout(hard);

    // The command may start its server as its own child; the port is only
    // free once that process is gone, and a re-start would fail on a busy port.
    const port = this.config?.preview.port;
    if (!port) return;
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && (await portAccepts(port))) await sleep(100);
  }

  // -------------------------------------------------------------------------
  // Process capture
  // -------------------------------------------------------------------------

  private async git(args: string[], cwd = this.root): Promise<string> {
    const windows = currentPlatform() === "win32";
    const result = await this.capture("git", {
      cwd,
      // `.cmd` shims are not executables on Windows.
      shell: windows,
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ANTHROPIC_API_KEY: undefined },
    }, args);
    if (result.code === 0) return result.output;
    throw new Error(
      redact(`git ${args[0]} 실패 (exit ${result.code}): ${result.lastLine || result.output}`.trim(), this.pat),
    );
  }

  private capture(
    command: string,
    options: SpawnOptions,
    args: string[] = [],
  ): Promise<{ code: number | null; output: string; lastLine: string }> {
    const { promise, resolve, reject } =
      Promise.withResolvers<{ code: number | null; output: string; lastLine: string }>();

    let child: ChildProcess;
    try {
      child = spawn(command, args, options);
    } catch (error) {
      reject(error);
      return promise;
    }
    let output = "";
    let lastLine = "";
    const absorb = (chunk: Buffer) => {
      const text = String(chunk);
      // The whole output is kept for the 401 check but only the tail is worth
      // holding: an install can print megabytes.
      output = (output + text).slice(-20_000);
      const line = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop();
      if (line) {
        lastLine = line;
        this.setDetail(line);
      }
    };
    child.stdout?.on("data", absorb);
    child.stderr?.on("data", absorb);
    child.once("error", (error) =>
      reject(
        error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT"
          ? new Error(GIT_MISSING_DETAIL)
          : error,
      ),
    );
    child.once("close", (code) => resolve({ code, output, lastLine }));
    return promise;
  }

  // -------------------------------------------------------------------------
  // Status plumbing
  // -------------------------------------------------------------------------

  private snapshot(): RepoStatus {
    const port = this.phase === "ready" ? (this.config?.preview.port ?? null) : null;
    return {
      root: this.root,
      phase: this.phase,
      detail: this.detail,
      previewUrl: port === null ? null : `http://127.0.0.1:${port}`,
      previewPort: port,
      url: this.url,
      patConfigured: this.pat !== null,
    };
  }

  private setPhase(phase: RepoPhase, detail: string | null): void {
    this.phase = phase;
    this.detail = detail;
    this.emit();
  }

  private setDetail(detail: string): void {
    this.detail = detail;
    // Progress lines arrive faster than any UI can use them.
    if (Date.now() - this.lastEmit < DETAIL_THROTTLE_MS) return;
    this.emit();
  }

  private emit(): void {
    this.lastEmit = Date.now();
    this.onStatus(this.snapshot());
  }
}

export const GIT_MISSING_DETAIL =
  "git을 찾을 수 없습니다 — git을 설치한 뒤 다시 시도해 주세요.";

function detailOf(error: unknown, pat: string | null): string {
  return redact(error instanceof Error ? error.message : String(error), pat);
}

// ---------------------------------------------------------------------------
// Planning document attachments
// ---------------------------------------------------------------------------

export interface SpecFile {
  name: string;
  mediaType: string;
  /** base64 */
  data: string;
}

const ALLOWED_SPEC_EXTENSIONS = [".md", ".txt", ".pdf", ".png", ".jpg", ".jpeg", ".webp"];
const MAX_SPEC_NAME = 100;

/**
 * `<YYYY-MM-DD>-<original name>.<ext>`, unique within `specs/`.
 *
 * The name reaches Claude as an `@specs/…` mention and reaches the filesystem
 * of three operating systems, so anything a path parser could read as
 * structure is removed. Spaces and Korean stay: the planner recognises their
 * own document by them.
 */
export function specFileName(
  original: string,
  date: string,
  taken: (candidate: string) => boolean,
): string {
  const dot = original.lastIndexOf(".");
  const extension = dot > 0 ? original.slice(dot).toLowerCase() : "";
  if (!ALLOWED_SPEC_EXTENSIONS.includes(extension)) {
    throw new Error(
      `첨부할 수 없는 파일 형식입니다: ${extension || original} (허용: ${ALLOWED_SPEC_EXTENSIONS.join(" ")})`,
    );
  }

  const cleaned =
    (dot > 0 ? original.slice(0, dot) : original)
      .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, "")
      .replace(/^\.+/, "")
      .trim() || "spec";

  // Planners date their filenames too, and `2026-09-08-2026-09-08-…` reads as
  // a bug to the person who attached it.
  const prefix = /^\d{4}-\d{2}-\d{2}-/.test(cleaned) ? "" : `${date}-`;
  const base = prefix + cleaned.slice(0, Math.max(1, MAX_SPEC_NAME - prefix.length - extension.length));

  let candidate = base + extension;
  for (let n = 2; taken(candidate); n += 1) candidate = `${base}-${n}${extension}`;
  return candidate;
}

/** Writes each attachment into `<cwd>/specs/` and returns the relative paths. */
export function saveSpecFiles(cwd: string, files: SpecFile[], now = new Date()): string[] {
  const dir = join(cwd, "specs");
  mkdirSync(dir, { recursive: true });
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

  const saved: string[] = [];
  for (const file of files) {
    const name = specFileName(
      file.name,
      date,
      (candidate) => existsSync(join(dir, candidate)) || saved.includes(`specs/${candidate}`),
    );
    writeFileSync(join(dir, name), Buffer.from(file.data, "base64"));
    saved.push(`specs/${name}`);
  }
  return saved;
}

// ---------------------------------------------------------------------------
// Workspace trust
// ---------------------------------------------------------------------------

/**
 * Claude Code drops every `permissions.allow` entry from a project's
 * `.claude/settings.json` until that directory has been trusted, and says so
 * only on stderr. The repo's rules are what keep approval cards away from a
 * planner, so an untrusted clone silently turns the product into a stream of
 * permission prompts. The trust dialog is interactive and the daemon has no
 * terminal, so record the acceptance the same way the CLI does.
 *
 * Connecting a repo is an explicit act by the planner, so accepting on their
 * behalf grants nothing they did not ask for.
 */
export function trustWorkspace(root: string, home = homedir()): void {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? home;
  const configFile = join(configDir, ".claude.json");
  mkdirSync(configDir, { recursive: true });

  let config: { projects?: Record<string, Record<string, unknown>> } = {};
  if (existsSync(configFile)) {
    try {
      config = JSON.parse(readFileSync(configFile, "utf8"));
    } catch {
      // A corrupt config is the CLI's problem to report; overwriting it with a
      // fresh object would throw away the user's own projects.
      return;
    }
  }

  // The CLI keys projects by the resolved cwd, which on macOS turns /tmp into
  // /private/tmp. Record both spellings when they differ.
  const keys = new Set([root]);
  try {
    keys.add(realpathSync(root));
  } catch {
    // Not created yet; the literal path is the best we can do.
  }

  const projects = (config.projects ??= {});
  let changed = false;
  for (const key of keys) {
    const project = (projects[key] ??= {});
    if (project.hasTrustDialogAccepted !== true) {
      project.hasTrustDialogAccepted = true;
      changed = true;
    }
  }
  if (!changed) return;

  // The CLI rewrites this file whenever a session ends, so replace it in one
  // step rather than leaving a window where it is half written.
  const temporary = `${configFile}.agent-hub-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, configFile);
}

// ---------------------------------------------------------------------------
// Small process/network helpers
// ---------------------------------------------------------------------------

/** Identity of the installed dependency set: reinstall exactly when it moves. */
function dependencyHash(root: string): string {
  const hash = createHash("sha256");
  for (const file of ["package.json", "pnpm-lock.yaml", "package-lock.json", "yarn.lock"]) {
    const path = join(root, file);
    hash.update(file);
    hash.update(existsSync(path) ? readFileSync(path) : Buffer.alloc(0));
  }
  return hash.digest("hex").slice(0, 16);
}

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    // Detached on POSIX means the shell and its children share a process
    // group; signalling the group is what actually releases the port.
    if (currentPlatform() !== "win32" && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    child.kill(signal);
  }
}

function portAccepts(port: number): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const socket = createConnection({ port, host: "127.0.0.1" });
  const settle = (ok: boolean) => {
    socket.destroy();
    resolve(ok);
  };
  socket.setTimeout(1_000);
  socket.once("connect", () => settle(true));
  socket.once("timeout", () => settle(false));
  socket.once("error", () => settle(false));
  return promise;
}

function respondsOk(url: string): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const request = httpGet(url, (response) => {
    response.resume();
    resolve(response.statusCode === 200);
  });
  request.setTimeout(2_000, () => {
    request.destroy();
    resolve(false);
  });
  request.once("error", () => resolve(false));
  return promise;
}
