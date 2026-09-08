import { randomUUID } from "node:crypto";
import {
  query,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AskQuestion,
  ChatEvent,
  ContextUsage,
  PermissionMode,
  PermissionSuggestion,
  SessionState,
} from "@agent-hub/protocol";
import { saveSpecFiles, type SpecFile } from "./repo.js";
import { MessageTranslator } from "./translate.js";
import { resolve, sep } from "node:path";

/** An async iterable the daemon can push user turns into while the query runs. */
class PushQueue implements AsyncIterable<SDKUserMessage> {
  private buffer: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private closed = false;

  push(message: SDKUserMessage): void {
    if (this.closed) return;
    this.buffer.push(message);
    this.wake?.();
  }

  close(): void {
    this.closed = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    while (true) {
      const next = this.buffer.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => (this.wake = resolve));
      this.wake = null;
    }
  }
}

interface PendingRequest {
  requestId: string;
  kind: "permission" | "question";
  toolName: string;
  resolve: (result: PermissionOutcome) => void;
  suggestions: PermissionUpdate[];
  /** Kept so an approval can echo the tool input back without the client resending it. */
  input: Record<string, unknown>;
}

type PermissionOutcome = PermissionResult;

export interface SessionEvents {
  onEvent: (sessionId: string, event: ChatEvent) => void;
  onState: (sessionId: string, state: SessionState, detail?: string) => void;
  onPermissionRequest: (payload: {
    requestId: string;
    sessionId: string;
    toolName: string;
    input: unknown;
    suggestions: PermissionSuggestion[];
  }) => void;
  onQuestionRequest: (payload: {
    requestId: string;
    sessionId: string;
    questions: AskQuestion[];
  }) => void;
}

export interface SessionOptions {
  cwd: string;
  claudeExecutable: string;
  /** Resume an existing transcript. */
  resume?: string;
}

/**
 * File-edit tools that `acceptEdits` mode used to silence. Under the pinned
 * `default` mode the CLI asks about them like anything else, so the daemon
 * answers here instead: silent for the planner, but only ever for paths
 * inside the workspace.
 */
const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

export class Session {
  readonly id: string;
  readonly cwd: string;
  state: SessionState = "idle";
  permissionMode: PermissionMode = "default";
  model: string | null = null;
  lastActivity = Date.now();
  title = "새 기획";

  private readonly queue = new PushQueue();
  private readonly translator = new MessageTranslator();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly events: SessionEvents;
  private run: Query;
  private consumer: Promise<void>;
  private closed = false;

  constructor(options: SessionOptions, events: SessionEvents) {
    this.events = events;
    this.cwd = options.cwd;

    // `sessionId` lets us name the session up front. Without it the id only
    // arrives with the init event, which the CLI does not emit until the first
    // user turn is pushed.
    this.id = options.resume ?? randomUUID();

    this.run = query({
      prompt: this.queue,
      options: {
        cwd: options.cwd,
        pathToClaudeCodeExecutable: options.claudeExecutable,
        // `default` is pinned on purpose: current CLI builds auto-approve
        // safe Bash under acceptEdits/auto without ever consulting
        // `canUseTool`, which would let a session run shell commands with no
        // planner in the loop. The daemon answers edit-class tools itself
        // (see canUse), so the UX stays "edits are silent, everything else
        // surfaces".
        permissionMode: "default",
        // Policy tier beats a user's own `defaultMode` (e.g. `"auto"`) in
        // ~/.claude/settings.json — without it that setting silently widens
        // every hub session.
        managedSettings: { permissions: { defaultMode: "default" } },
        includePartialMessages: true,
        // Load the same user/project configuration the terminal would, so
        // CLAUDE.md, skills, and permission rules behave identically.
        settingSources: ["user", "project", "local"],
        ...(options.resume ? { resume: options.resume } : { sessionId: this.id }),
        canUseTool: (toolName, input, opts) => this.canUse(toolName, input, opts),
      },
    });

    this.consumer = this.consume();
  }

  private async consume(): Promise<void> {
    try {
      for await (const message of this.run) {
        this.lastActivity = Date.now();
        for (const event of this.translator.translate(message)) {
          if (event.kind === "init") {
            this.model = event.model;
            this.permissionMode = event.permissionMode;
          }
          if (event.kind === "turn.end") {
            this.setState(this.pending.size > 0 ? this.state : "idle");
          }
          this.events.onEvent(this.id, event);
        }
      }
      this.setState("closed");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.events.onEvent(this.id, { kind: "notice", level: "error", text: detail });
      this.setState("error", detail);
    } finally {
      // A crashed or finished query can never answer a pending prompt.
      for (const request of this.pending.values()) {
        request.resolve({ behavior: "deny", message: "Session ended before approval" });
      }
      this.pending.clear();
    }
  }

  private setState(state: SessionState, detail?: string): void {
    if (this.state === state) return;
    this.state = state;
    this.events.onState(this.id, state, detail);
  }

  /**
   * The hub's single permission choke point. Edit-class tools inside the
   * workspace are allowed without surfacing; everything else goes to the
   * planner as a permission (or question) card.
   */
  private canUse(
    toolName: string,
    input: Record<string, unknown>,
    opts: { signal: AbortSignal; suggestions?: PermissionUpdate[] },
  ): Promise<PermissionResult> {
    if (EDIT_TOOLS.has(toolName)) {
      const paths = [input.file_path, input.notebook_path].filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      );
      if (paths.length > 0 && paths.every((value) => this.insideWorkspace(value))) {
        return Promise.resolve({ behavior: "allow", updatedInput: input });
      }
    }
    return this.handlePermission(toolName, input, opts);
  }

  /** Editors may write absolute or cwd-relative paths; both must stay inside. */
  private insideWorkspace(value: string): boolean {
    const abs = resolve(this.cwd, value);
    return abs === this.cwd || abs.startsWith(this.cwd + sep);
  }

  private handlePermission(
    toolName: string,
    input: Record<string, unknown>,
    opts: { signal: AbortSignal; suggestions?: PermissionUpdate[] },
  ): Promise<PermissionOutcome> {
    const requestId = randomUUID();
    const suggestions = opts.suggestions ?? [];

    return new Promise<PermissionOutcome>((resolve) => {
      const settle = (outcome: PermissionOutcome) => {
        if (!this.pending.has(requestId)) return;
        this.pending.delete(requestId);
        if (this.pending.size === 0 && this.state !== "closed" && this.state !== "error") {
          this.setState("running");
        }
        resolve(outcome);
      };

      this.pending.set(requestId, {
        requestId,
        kind: toolName === "AskUserQuestion" ? "question" : "permission",
        toolName,
        resolve: settle,
        suggestions,
        input,
      });

      // If the query is torn down while a human is deciding, stop waiting.
      opts.signal.addEventListener(
        "abort",
        () => settle({ behavior: "deny", message: "Request cancelled" }),
        { once: true },
      );

      if (toolName === "AskUserQuestion") {
        this.setState("waiting_question");
        this.events.onQuestionRequest({
          requestId,
          sessionId: this.id,
          questions: normalizeQuestions(input),
        });
      } else {
        this.setState("waiting_permission");
        this.events.onPermissionRequest({
          requestId,
          sessionId: this.id,
          toolName,
          input,
          suggestions: describeSuggestions(suggestions),
        });
      }
    });
  }

  hasPending(requestId: string): boolean {
    return this.pending.has(requestId);
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  listPending(): Array<{ requestId: string; kind: "permission" | "question"; toolName: string }> {
    return [...this.pending.values()].map(({ requestId, kind, toolName }) => ({
      requestId,
      kind,
      toolName,
    }));
  }

  respondPermission(
    requestId: string,
    decision: "allow" | "allowAlways" | "deny",
    message?: string,
    updatedInput?: Record<string, unknown>,
  ): boolean {
    const request = this.pending.get(requestId);
    if (!request) return false;

    if (decision === "deny") {
      request.resolve({ behavior: "deny", message: message ?? "User denied this action" });
      return true;
    }

    const input = updatedInput ?? request.input;
    if (decision === "allowAlways") {
      // Echo the CLI's own suggestions back so the same call stops prompting.
      // Bash-style calls offer an `addRules` update destined for
      // .claude/settings.local.json; Write and Edit instead offer a session
      // `setMode` switch to acceptEdits. Both are valid "stop asking" answers.
      request.resolve({
        behavior: "allow",
        updatedInput: input,
        updatedPermissions: request.suggestions,
      });
      return true;
    }

    request.resolve({ behavior: "allow", updatedInput: input });
    return true;
  }

  respondQuestion(
    requestId: string,
    answers: Record<string, string | string[]>,
    response: string | undefined,
  ): boolean {
    const request = this.pending.get(requestId);
    if (!request) return false;
    // The tool requires the original questions array back alongside the answers.
    const updatedInput: Record<string, unknown> = {
      questions: request.input.questions,
      answers,
    };
    if (response) updatedInput.response = response;
    request.resolve({ behavior: "allow", updatedInput });
    return true;
  }

  send(
    text: string,
    images?: Array<{ mediaType: string; data: string }>,
    files?: SpecFile[],
  ): void {
    if (this.closed) throw new Error("session is closed");
    // Documents go to disk and reach Claude as `@specs/…` mentions: its Read
    // tool handles PDF page ranges and image downscaling, and the workspace
    // keeps the source document for HANDOFF.md and later sessions.
    const saved = files && files.length > 0 ? saveSpecFiles(this.cwd, files) : [];
    const prompt = saved.reduce((acc, path) => `${acc}\n\n첨부 기획서: @${path}`, text);
    const content =
      images && images.length > 0
        ? [
            { type: "text" as const, text: prompt },
            ...images.map((image) => ({
              type: "image" as const,
              source: { type: "base64" as const, media_type: image.mediaType, data: image.data },
            })),
          ]
        : prompt;

    const title = text.trim() || saved.join(", ");
    if (this.title === "새 기획" && title) {
      this.title = title.slice(0, 80);
    }

    this.queue.push({
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      session_id: this.id,
    } as SDKUserMessage);

    this.lastActivity = Date.now();
    this.setState("running");
    // The echo carries the person's own words; the appended mentions are
    // plumbing, and the saved paths render as attachment chips instead.
    this.events.onEvent(this.id, {
      kind: "user.echo",
      text,
      images: images?.length ?? 0,
      files: saved,
    });
  }

  async interrupt(): Promise<void> {
    await this.run.interrupt();
    this.setState("idle");
  }

  async contextUsage(): Promise<ContextUsage | null> {
    try {
      const usage = await this.run.getContextUsage({ detail: "summary" });
      return {
        totalTokens: usage.totalTokens,
        maxTokens: usage.maxTokens,
        percentage: usage.percentage,
        model: usage.model,
      };
    } catch {
      return null;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const request of this.pending.values()) {
      request.resolve({ behavior: "deny", message: "Session closed by user" });
    }
    this.pending.clear();
    this.queue.close();
    try {
      await this.run.interrupt();
    } catch {
      // Already finished; nothing to interrupt.
    }
    await this.consumer.catch(() => undefined);
    this.setState("closed");
  }
}

function describeSuggestions(suggestions: PermissionUpdate[]): PermissionSuggestion[] {
  return suggestions.map((raw) => {
    const s = raw as Record<string, any>;
    const destination = String(s?.destination ?? "session");
    const persisted = destination === "localSettings" || destination === "projectSettings";
    const scope = persisted ? "saved for next time" : "this session only";

    if (s?.type === "setMode" && s?.mode) {
      return { destination, label: `switch to ${s.mode} mode (${scope})`, raw };
    }
    if (Array.isArray(s?.rules) && s.rules.length > 0) {
      const rules = s.rules
        .map((r: Record<string, any>) =>
          r?.ruleContent ? `${r.toolName}(${r.ruleContent})` : String(r?.toolName ?? ""),
        )
        .filter(Boolean)
        .join(", ");
      return { destination, label: `allow ${rules} (${scope})`, raw };
    }
    return { destination, label: `${String(s?.type ?? "update")} (${scope})`, raw };
  });
}

function normalizeQuestions(input: Record<string, unknown>): AskQuestion[] {
  const questions = (input as { questions?: unknown }).questions;
  if (!Array.isArray(questions)) return [];
  return questions.map((raw) => {
    const q = raw as Record<string, any>;
    return {
      question: String(q?.question ?? ""),
      header: String(q?.header ?? ""),
      multiSelect: Boolean(q?.multiSelect),
      options: Array.isArray(q?.options)
        ? q.options.map((opt: Record<string, any>) => ({
            label: String(opt?.label ?? ""),
            description: String(opt?.description ?? ""),
            ...(opt?.preview ? { preview: String(opt.preview) } : {}),
          }))
        : [],
    };
  });
}
