import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { promisify } from "node:util";
import type { DaemonStatus } from "@agent-hub/protocol";
import { PROTOCOL_VERSION } from "@agent-hub/protocol";

const run = promisify(execFile);

export const HUB_DIR = join(homedir(), ".agent-hub");

export type Platform = "win32" | "darwin" | "linux";

/** `win32` is the only branch that matters; macOS and Linux install alike. */
export function currentPlatform(): Platform {
  return process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
}

/**
 * Where Claude Code's own installers put the binary, in the order we trust them.
 *
 * Pure so the branch for the platform this daemon is not running on can still
 * be tested. The native installer owns `~/.local/bin` on every platform; the
 * remaining entries cover Homebrew on macOS and WinGet on Windows.
 */
export function claudeCandidates(
  platform: Platform,
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    return [
      join(home, ".local", "bin", "claude.exe"),
      join(localAppData, "Microsoft", "WinGet", "Links", "claude.exe"),
      join(localAppData, "Programs", "claude", "claude.exe"),
    ];
  }
  return [
    join(home, ".local", "bin", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    "/usr/bin/claude",
  ];
}

/** The shell-free way to ask the OS where a command lives. */
export function lookupCommand(platform: Platform): { command: string; args: string[] } {
  return platform === "win32"
    ? { command: "where", args: ["claude.exe"] }
    : { command: "which", args: ["claude"] };
}

/**
 * Where pnpm's own installers put it. The standalone script owns `PNPM_HOME`
 * (`~/Library/pnpm` on macOS, `~/.local/share/pnpm` on Linux, `%LOCALAPPDATA%\pnpm`
 * on Windows); corepack and `npm i -g` instead drop a shim beside the node
 * binary that is running us, and the native installer layout that already owns
 * `~/.local/bin/claude` puts pnpm there too.
 *
 * `nodeDir` is a parameter rather than a `process.execPath` read so the Windows
 * branch stays testable from a Mac.
 */
export function pnpmCandidates(
  platform: Platform,
  home: string,
  env: NodeJS.ProcessEnv = process.env,
  nodeDir: string = dirname(process.execPath),
): string[] {
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    const appData = env.APPDATA ?? join(home, "AppData", "Roaming");
    return [
      ...(env.PNPM_HOME ? [join(env.PNPM_HOME, "pnpm.cmd")] : []),
      join(nodeDir, "pnpm.cmd"),
      join(localAppData, "pnpm", "pnpm.cmd"),
      join(appData, "npm", "pnpm.cmd"),
    ];
  }
  return [
    ...(env.PNPM_HOME ? [join(env.PNPM_HOME, "pnpm")] : []),
    // A GUI-launched daemon inherits a minimal PATH, so `which pnpm` misses
    // exactly the installs a terminal would find. These two cover them.
    join(nodeDir, "pnpm"),
    join(home, ".local", "bin", "pnpm"),
    ...(platform === "darwin" ? [join(home, "Library", "pnpm", "pnpm")] : []),
    join(home, ".local", "share", "pnpm", "pnpm"),
    "/opt/homebrew/bin/pnpm",
    "/usr/local/bin/pnpm",
    "/usr/bin/pnpm",
  ];
}

/** The connected repo's install and preview commands may be pnpm ones. */
export async function resolvePnpmExecutable(): Promise<string | null> {
  const platform = currentPlatform();
  for (const candidate of pnpmCandidates(platform, homedir())) {
    if (existsSync(candidate)) return candidate;
  }
  try {
    const { stdout } = await run(
      platform === "win32" ? "where" : "which",
      [platform === "win32" ? "pnpm.cmd" : "pnpm"],
    );
    const found = stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (found) return found;
  } catch {
    // Nothing on PATH; corepack has not been enabled either.
  }
  return null;
}

/**
 * pnpm reports a private-registry rejection as a 401/403 fetch error. A bare
 * `401` is not enough: install progress lines count packages ("resolved 401").
 */
export function detectsRegistryAuthFailure(output: string): boolean {
  return /ERR_PNPM_FETCH_40[13]|\bunauthorized\b|\bforbidden\b|authentication token|status(?: code)? 40[13]\b/i.test(
    output,
  );
}

type RegistryAuth = "ok" | "unauthenticated" | "unknown";

/**
 * The PATH a child needs. pnpm and the Claude CLI ship as scripts whose shebang
 * is `#!/usr/bin/env node`, so spawning either fails when node is not on PATH —
 * exactly the case for a daemon started from a desktop app rather than a shell.
 * The daemon widens its own PATH with this at startup, once, so every child
 * inherits it.
 */
export function childPath(env: NodeJS.ProcessEnv = process.env, nodeDir = dirname(process.execPath)): string {
  const separator = currentPlatform() === "win32" ? ";" : ":";
  const parts = (env.PATH ?? "").split(separator).filter(Boolean);
  return parts.includes(nodeDir) ? parts.join(separator) : [nodeDir, ...parts].join(separator);
}

/** A network round trip per status request would stall every client connect. */
const registryAuthCache = new Map<string, { value: RegistryAuth; readAt: number }>();
const REGISTRY_AUTH_TTL_MS = 5 * 60_000;

/**
 * Whether this machine can read the CDS packages from GitHub Packages. Run in
 * the connected repo's clone so its `.npmrc` (registry mapping) is in scope;
 * repos that declare no registry are not probed at all.
 */
export async function readCdsRegistryAuth(pnpm: string | null, cwd: string | null): Promise<RegistryAuth> {
  if (!pnpm || !cwd || !existsSync(cwd)) return "unknown";
  const cached = registryAuthCache.get(cwd);
  if (cached && Date.now() - cached.readAt < REGISTRY_AUTH_TTL_MS) return cached.value;

  const value = await probeCdsRegistry(pnpm, cwd);
  registryAuthCache.set(cwd, { value, readAt: Date.now() });
  return value;
}

async function probeCdsRegistry(pnpm: string, cwd: string): Promise<RegistryAuth> {
  try {
    const { stdout } = await run(pnpm, ["view", "@colosseumcoinckr/cds", "version"], {
      cwd,
      shell: currentPlatform() === "win32",
      timeout: 20_000,
    });
    return /\d+\.\d+\.\d+/.test(stdout) ? "ok" : "unknown";
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    const text = `${failure.stdout ?? ""}${failure.stderr ?? ""}${String(error)}`;
    // Anything else (offline, registry down, no such package) is not something
    // the user can fix by pasting a token, so it must not claim they must.
    return detectsRegistryAuthFailure(text) ? "unauthenticated" : "unknown";
  }
}

/**
 * Resolve the Claude Code binary this daemon should drive.
 *
 * We deliberately prefer the user's own installed CLI: it is the binary they
 * ran `/login` against, so the session bills to their subscription. The binary
 * is used unmodified, which is what Anthropic's terms require.
 */
export async function resolveClaudeExecutable(override?: string): Promise<string | null> {
  const platform = currentPlatform();
  const candidates = [
    override,
    process.env.AGENT_HUB_CLAUDE_BIN,
    ...claudeCandidates(platform, homedir()),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (existsSync(candidate)) return resolveRealPath(candidate);
  }

  try {
    const { command, args } = lookupCommand(platform);
    const { stdout } = await run(command, args);
    // `where` can report several hits; the first is the one that would run.
    const found = stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (found) return resolveRealPath(found);
  } catch {
    // Both `which` and `where` exit non-zero when nothing matches.
  }
  return null;
}

/**
 * The installed `claude` entry is usually a symlink into a versioned binary
 * (`~/.local/share/claude/versions/<version>`). Resolve it so the daemon
 * records the exact binary it drives, which is what the status view reports.
 */
function resolveRealPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export async function readClaudeVersion(executable: string): Promise<string | null> {
  try {
    const { stdout } = await run(executable, ["--version"]);
    return stdout.trim();
  } catch {
    return null;
  }
}

interface AuthStatus {
  loggedIn: boolean;
  authMethod: string | null;
  subscriptionType: string | null;
  email: string | null;
}

export async function readAuthStatus(executable: string): Promise<AuthStatus> {
  try {
    const { stdout } = await run(executable, ["auth", "status"]);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    return {
      loggedIn: Boolean(parsed.loggedIn),
      authMethod: typeof parsed.authMethod === "string" ? parsed.authMethod : null,
      subscriptionType:
        typeof parsed.subscriptionType === "string" ? parsed.subscriptionType : null,
      email: typeof parsed.email === "string" ? parsed.email : null,
    };
  } catch {
    return { loggedIn: false, authMethod: null, subscriptionType: null, email: null };
  }
}

export async function isGitAvailable(): Promise<boolean> {
  try {
    await run("git", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

export async function buildStatus(input: {
  executable: string | null;
  liveSessions: number;
  pendingPermissions: number;
  /**
   * Directory to probe GitHub Packages auth in — the connected repo's clone,
   * and only when that repo declares a registry. Null otherwise.
   */
  registryProbeDir: string | null;
}): Promise<DaemonStatus> {
  const warnings: string[] = [];
  const apiKeyInEnv = Boolean(process.env.ANTHROPIC_API_KEY);
  if (apiKeyInEnv) {
    warnings.push(
      "ANTHROPIC_API_KEY is set in the daemon environment. Sessions would bill that key instead of the signed-in subscription. Unset it and restart.",
    );
  }
  if (!input.executable) {
    warnings.push("Claude Code CLI not found. Install it and run `claude /login`.");
  }

  const version = input.executable ? await readClaudeVersion(input.executable) : null;
  const auth = input.executable
    ? await readAuthStatus(input.executable)
    : { loggedIn: false, authMethod: null, subscriptionType: null, email: null };

  if (input.executable && !auth.loggedIn) {
    warnings.push("Not signed in. Run `claude /login` in a terminal on this machine.");
  }

  const gitAvailable = await isGitAvailable();
  if (!gitAvailable) {
    warnings.push(
      currentPlatform() === "win32"
        ? "git was not found. Install Git for Windows so file mentions respect .gitignore and Claude Code can use the Bash tool."
        : "git was not found. File mentions will fall back to a directory walk that ignores .gitignore.",
    );
  }

  const pnpm = await resolvePnpmExecutable();
  if (!pnpm) {
    warnings.push(
      "pnpm was not found. The connected repo's install and preview commands cannot run if they need it. Run `corepack enable` or `npm i -g pnpm`.",
    );
  }
  const cdsRegistryAuth = await readCdsRegistryAuth(pnpm, input.registryProbeDir);
  if (cdsRegistryAuth === "unauthenticated") {
    warnings.push(
      "GitHub Packages rejected the request for @colosseumcoinckr/cds. Run `pnpm config set //npm.pkg.github.com/:_authToken <PAT with read:packages>`.",
    );
  } else if (cdsRegistryAuth === "unknown" && pnpm && input.registryProbeDir) {
    warnings.push(
      "Could not verify access to @colosseumcoinckr/cds on GitHub Packages. The connected repo's install will fail if this machine is offline or unauthenticated.",
    );
  }

  return {
    protocolVersion: PROTOCOL_VERSION,
    platform: process.platform,
    claudeVersion: version,
    claudeExecutable: input.executable,
    gitAvailable,
    loggedIn: auth.loggedIn,
    authMethod: auth.authMethod,
    subscriptionType: auth.subscriptionType,
    email: auth.email,
    apiKeyInEnv,
    liveSessions: input.liveSessions,
    pendingPermissions: input.pendingPermissions,
    pnpmAvailable: Boolean(pnpm),
    cdsRegistryAuth,
    warnings,
  };
}

/**
 * File list for @-mention autocomplete.
 *
 * Prefers `git ls-files` because it is fast and already respects .gitignore,
 * which keeps node_modules and build output out of the picker. Directories
 * that are not repositories fall back to a bounded walk in Node, so nothing
 * here depends on a shell utility that exists on only one platform.
 */
const fileCache = new Map<string, { files: string[]; readAt: number }>();
const FILE_CACHE_TTL_MS = 15_000;
const WALK_FILE_LIMIT = 20_000;
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".venv",
  "__pycache__",
]);

async function walk(root: string): Promise<string[]> {
  const found: string[] = [];
  const queue: string[] = [""];

  while (queue.length > 0 && found.length < WALK_FILE_LIMIT) {
    const relative = queue.shift()!;
    let entries;
    try {
      entries = await readdir(join(root, relative), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.isDirectory()) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        queue.push(relative ? `${relative}/${entry.name}` : entry.name);
      } else if (entry.isFile()) {
        found.push(relative ? `${relative}/${entry.name}` : entry.name);
        if (found.length >= WALK_FILE_LIMIT) break;
      }
    }
  }
  return found;
}

export async function listFiles(cwd: string): Promise<string[]> {
  const cached = fileCache.get(cwd);
  if (cached && Date.now() - cached.readAt < FILE_CACHE_TTL_MS) return cached.files;
  if (!existsSync(cwd)) return [];

  let files: string[] = [];
  try {
    const { stdout } = await run(
      "git",
      ["-C", cwd, "ls-files", "--cached", "--others", "--exclude-standard"],
      { maxBuffer: 32 * 1024 * 1024 },
    );
    // git always reports forward slashes, including on Windows.
    files = stdout.split(/\r?\n/).filter(Boolean);
  } catch {
    files = await walk(cwd);
  }

  files.sort();
  fileCache.set(cwd, { files, readAt: Date.now() });
  return files;
}

/** Rank matches so a hit in the filename beats a hit deep in the path. */
export function filterFiles(files: string[], query: string, limit: number): string[] {
  if (!query) return files.slice(0, limit);
  const needle = query.toLowerCase();
  const scored: Array<{ file: string; score: number }> = [];
  for (const file of files) {
    const lower = file.toLowerCase();
    const index = lower.indexOf(needle);
    if (index === -1) continue;
    const base = lower.slice(lower.lastIndexOf("/") + 1);
    const inName = base.includes(needle);
    scored.push({ file, score: (inName ? 0 : 1000) + index + file.length / 1000 });
    if (scored.length > limit * 20) break;
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, limit).map((s) => s.file);
}
