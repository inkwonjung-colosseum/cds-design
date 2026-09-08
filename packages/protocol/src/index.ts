import { z } from "zod";

/**
 * Wire protocol between the hub daemon (runs on the planner's own machine,
 * drives their own Claude Code login) and the planner UI.
 *
 * There is exactly one workspace — the clone of the repo the planner
 * connected, which the daemon owns — so no message names a directory. The
 * daemon resolves every path itself, which also means a client can never
 * point a session at an arbitrary folder.
 *
 * Client -> daemon messages are validated with zod because they arrive over a
 * socket. Daemon -> client messages are produced by us, so they are plain types.
 */

export const PROTOCOL_VERSION = 3;

// ---------------------------------------------------------------------------
// Shared enums
// ---------------------------------------------------------------------------

export const permissionModeSchema = z.enum([
  "default",
  "plan",
  "acceptEdits",
  "dontAsk",
  "bypassPermissions",
]);
export type PermissionMode = z.infer<typeof permissionModeSchema>;

export type SessionState =
  | "starting"
  | "idle"
  | "running"
  | "waiting_permission"
  | "waiting_question"
  | "error"
  | "closed";

// ---------------------------------------------------------------------------
// Client -> daemon
// ---------------------------------------------------------------------------

const withId = { id: z.string().min(1) };

export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({ ...withId, type: z.literal("daemon.status") }),
  z.object({
    ...withId,
    type: z.literal("session.list"),
    limit: z.number().int().positive().max(200).optional(),
  }),
  z.object({
    ...withId,
    type: z.literal("session.history"),
    sessionId: z.string().min(1),
  }),
  z.object({
    ...withId,
    type: z.literal("session.create"),
    /** Continue an existing planning thread by id. */
    resume: z.string().optional(),
  }),
  z.object({
    ...withId,
    type: z.literal("session.send"),
    sessionId: z.string().min(1),
    text: z.string(),
    /** Optional base64 image attachments. */
    images: z
      .array(z.object({ mediaType: z.string().min(1), data: z.string().min(1) }))
      .optional(),
    /**
     * Planning documents. The daemon saves each one under `<cwd>/specs/` and
     * appends an `@specs/<name>` reference to the prompt, so Claude reads it
     * with its own Read tool (which handles PDF page ranges and image
     * downscaling) instead of receiving the bytes inline.
     */
    files: z
      .array(
        z.object({
          name: z.string().min(1),
          mediaType: z.string().min(1),
          data: z.string().min(1),
        }),
      )
      .optional(),
  }),
  z.object({ ...withId, type: z.literal("session.interrupt"), sessionId: z.string().min(1) }),
  z.object({ ...withId, type: z.literal("session.close"), sessionId: z.string().min(1) }),
  z.object({ ...withId, type: z.literal("session.delete"), sessionId: z.string().min(1) }),
  z.object({ ...withId, type: z.literal("session.contextUsage"), sessionId: z.string().min(1) }),
  z.object({
    ...withId,
    type: z.literal("repo.files"),
    /** Substring filter for @-mention autocomplete. */
    query: z.string().optional(),
    limit: z.number().int().positive().max(500).optional(),
  }),
  z.object({
    ...withId,
    type: z.literal("permission.respond"),
    requestId: z.string().min(1),
    decision: z.enum(["allow", "allowAlways", "deny"]),
    /** Reason shown to Claude on deny. */
    message: z.string().optional(),
    /** Edited tool input on allow. */
    updatedInput: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    ...withId,
    type: z.literal("question.respond"),
    requestId: z.string().min(1),
    /** question text -> selected label(s) */
    answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
    /** Freeform reply instead of answering the structured questions. */
    response: z.string().optional(),
  }),
  /** Connected repo state. Reads disk and process state; no side effects. */
  z.object({ ...withId, type: z.literal("repo.status") }),
  /**
   * Idempotent bootstrap of the connected repo: clone when missing, pull,
   * install when the dependency hash moved, start the preview command
   * declared in `drafthouse.json`. Resolves when it settles; progress arrives
   * as `repo.status`.
   */
  z.object({ ...withId, type: z.literal("repo.sync") }),
  /**
   * Change the connected repo's url and/or PAT. The daemon persists both
   * daemon-side and re-clones when the url moved. The PAT is never echoed
   * back: the reply is the resulting `RepoStatus`, which carries presence
   * (`patConfigured`) only.
   */
  z.object({
    ...withId,
    type: z.literal("repo.update"),
    /** Repository url; `null` clears it. */
    url: z.string().min(1).nullable().optional(),
    /** Personal access token, stored daemon-side only; `null` clears it. */
    pat: z.string().min(1).nullable().optional(),
  }),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

// ---------------------------------------------------------------------------
// Normalized chat events (daemon translates SDKMessage into these)
// ---------------------------------------------------------------------------

export type ChatEvent =
  | {
      kind: "init";
      sessionId: string;
      model: string;
      cwd: string;
      tools: string[];
      apiKeySource: string;
      /** Slash commands and agents available, for UI affordances. */
      permissionMode: PermissionMode;
    }
  | { kind: "text.delta"; blockId: string; text: string; agentId: string | null }
  | { kind: "text.done"; blockId: string; text: string; agentId: string | null }
  | { kind: "thinking.delta"; blockId: string; text: string; agentId: string | null }
  | {
      kind: "tool.start";
      toolUseId: string;
      name: string;
      input: unknown;
      agentId: string | null;
    }
  | {
      kind: "tool.end";
      toolUseId: string;
      isError: boolean;
      content: unknown;
      agentId: string | null;
    }
  /** `files` holds `specs/` paths of documents that rode along with the turn. */
  | { kind: "user.echo"; text: string; images: number; files: string[] }
  | {
      kind: "turn.end";
      subtype: string;
      isError: boolean;
      costUsd: number | null;
      numTurns: number | null;
      durationMs: number | null;
      /** Present when the turn ended because the model declined. */
      resultText: string | null;
    }
  | {
      kind: "retry";
      attempt: number;
      maxRetries: number;
      delayMs: number;
      error: string;
    }
  | { kind: "notice"; level: "info" | "warn" | "error"; text: string }
  | { kind: "compact"; trigger: string };

// ---------------------------------------------------------------------------
// Daemon -> client
// ---------------------------------------------------------------------------

export interface SessionSummary {
  sessionId: string;
  title: string;
  lastModified: number;
  /** True when this daemon currently holds a live query() for the session. */
  live: boolean;
  state: SessionState;
}

export interface DaemonStatus {
  protocolVersion: number;
  /** node's process.platform, so a bug report says which OS produced it. */
  platform: string;
  claudeVersion: string | null;
  claudeExecutable: string | null;
  /** git powers clone/pull, @-mention listing and Claude Code's Bash tool. */
  gitAvailable: boolean;
  loggedIn: boolean;
  authMethod: string | null;
  subscriptionType: string | null;
  email: string | null;
  /** True when ANTHROPIC_API_KEY is present, which would bill the key not the subscription. */
  apiKeyInEnv: boolean;
  liveSessions: number;
  pendingPermissions: number;
  warnings: string[];
  /** pnpm may drive the connected repo's install and preview commands. */
  pnpmAvailable: boolean;
  /**
   * Whether this machine can read @colosseumcoinckr packages from GitHub
   * Packages. Probed only when the connected repo declares a `registry`.
   */
  cdsRegistryAuth: "ok" | "unauthenticated" | "unknown";
}

export interface ContextUsage {
  totalTokens: number;
  maxTokens: number;
  percentage: number;
  model: string;
}

// ---------------------------------------------------------------------------
// Connected repo workspace
// ---------------------------------------------------------------------------

/**
 * Lifecycle of the connected repo clone:
 * `missing → cloning → pulling → installing (when needed) → starting → ready`,
 * with `error` reachable from every working phase.
 */
export type RepoPhase =
  | "missing"
  | "cloning"
  | "pulling"
  | "installing"
  | "starting"
  | "ready"
  | "error";

export interface RepoStatus {
  /** Absolute path of the clone on this machine. */
  root: string;
  phase: RepoPhase;
  /** Last progress line while working, or the reason for `error`. */
  detail: string | null;
  /** Preview origin once the declared preview port accepts connections. */
  previewUrl: string | null;
  /** Port declared in the repo's `drafthouse.json`. */
  previewPort: number | null;
  /** Configured remote url, without any embedded credentials. */
  url: string | null;
  /** Whether a PAT is stored daemon-side. The value never crosses the wire. */
  patConfigured: boolean;
}

export interface PermissionSuggestion {
  destination: string;
  label: string;
  raw: unknown;
}

export interface AskQuestionOption {
  label: string;
  description: string;
  preview?: string;
}

export interface AskQuestion {
  question: string;
  header: string;
  options: AskQuestionOption[];
  multiSelect: boolean;
}

export type ServerMessage =
  | { type: "hello"; protocolVersion: number; status: DaemonStatus }
  | { type: "ok"; id: string; data: unknown }
  | { type: "error"; id: string | null; message: string; code?: string }
  | { type: "session.event"; sessionId: string; event: ChatEvent }
  | { type: "session.state"; sessionId: string; state: SessionState; detail?: string }
  | {
      type: "permission.request";
      requestId: string;
      sessionId: string;
      toolName: string;
      input: unknown;
      suggestions: PermissionSuggestion[];
    }
  | {
      type: "question.request";
      requestId: string;
      sessionId: string;
      questions: AskQuestion[];
    }
  | { type: "status"; status: DaemonStatus }
  | { type: "repo.status"; status: RepoStatus };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function parseClientMessage(raw: string):
  | { ok: true; value: ClientMessage }
  | { ok: false; error: string; id: string | null } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: "invalid JSON", id: null };
  }
  const id =
    json && typeof json === "object" && typeof (json as { id?: unknown }).id === "string"
      ? (json as { id: string }).id
      : null;
  const parsed = clientMessageSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), id };
  }
  return { ok: true, value: parsed.data };
}
