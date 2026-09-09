import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AskQuestion,
  ChatEvent,
  ConfluenceSettings,
  ConfluencePageTree,
  ConfluenceSpaceList,
  ConfluenceReview,
  ConfluenceStatus,
  ContextUsage,
  EffortLevel,
  PermissionMode,
  DaemonStatus,
  DiffFile,
  DiffStatus,
  DocLock,
  DocSaved,
  DocState,
  DocSummary,
  HandoffStatus,
  OnboardingFixKind,
  OnboardingStep,
  PermissionSuggestion,
  ProjectList,
  ProjectSummary,
  RepoStatus,
  ServerMessage,
  SessionCommand,
  SessionState,
  SessionSelectors,
  SessionSummary,
  Workspace,
} from "@drafthouse/protocol";

// ---------------------------------------------------------------------------
// Transcript model: ChatEvents folded into renderable blocks
// ---------------------------------------------------------------------------

export type Block =
  | { type: "user"; id: string; text: string; images: number; files: string[] }
  | { type: "text"; id: string; text: string; agentId: string | null; streaming: boolean }
  | { type: "thinking"; id: string; text: string; agentId: string | null; streaming: boolean }
  | {
      type: "tool";
      id: string;
      name: string;
      input: unknown;
      agentId: string | null;
      result?: unknown;
      isError?: boolean;
      done: boolean;
    }
  | {
      type: "turn";
      id: string;
      subtype: string;
      isError: boolean;
      costUsd: number | null;
      durationMs: number | null;
    }
  | { type: "notice"; id: string; level: "info" | "warn" | "error"; text: string };

let noticeSeq = 0;

export function foldEvent(blocks: Block[], event: ChatEvent): Block[] {
  switch (event.kind) {
    case "user.echo":
      return [
        ...blocks,
        {
          type: "user",
          id: `u${++noticeSeq}`,
          text: event.text,
          images: event.images,
          files: event.files,
        },
      ];

    case "text.delta": {
      const index = blocks.findIndex((b) => b.type === "text" && b.id === event.blockId);
      if (index === -1) {
        return [
          ...blocks,
          {
            type: "text",
            id: event.blockId,
            text: event.text,
            agentId: event.agentId,
            streaming: true,
          },
        ];
      }
      const next = [...blocks];
      const current = next[index] as Extract<Block, { type: "text" }>;
      next[index] = { ...current, text: current.text + event.text };
      return next;
    }

    case "text.done": {
      const index = blocks.findIndex((b) => b.type === "text" && b.id === event.blockId);
      if (index !== -1) {
        const next = [...blocks];
        next[index] = {
          ...(next[index] as Extract<Block, { type: "text" }>),
          text: event.text,
          streaming: false,
        };
        return next;
      }
      // The block ids of the deltas and of the aggregated message can drift
      // apart — a stream that skips `message_start` has nothing to key on. The
      // API streams one text block at a time per agent, so a `done` with an
      // unfamiliar id is that streaming block under another name. Without this
      // the planner sees every sentence twice, once mid-stream and once final.
      const streaming = blocks.findLastIndex(
        (b) => b.type === "text" && b.streaming && b.agentId === event.agentId,
      );
      if (streaming !== -1) {
        const next = [...blocks];
        next[streaming] = {
          ...(next[streaming] as Extract<Block, { type: "text" }>),
          id: event.blockId,
          text: event.text,
          streaming: false,
        };
        return next;
      }
      if (!event.text.trim()) return blocks;
      return [
        ...blocks,
        { type: "text", id: event.blockId, text: event.text, agentId: event.agentId, streaming: false },
      ];
    }

    case "thinking.delta": {
      const index = blocks.findIndex((b) => b.type === "thinking" && b.id === event.blockId);
      if (index === -1) {
        return [
          ...blocks,
          { type: "thinking", id: event.blockId, text: event.text, agentId: event.agentId, streaming: true },
        ];
      }
      const next = [...blocks];
      const current = next[index] as Extract<Block, { type: "thinking" }>;
      next[index] = { ...current, text: current.text + event.text, streaming: true };
      return next;
    }

    case "tool.start":
      return [
        ...blocks,
        {
          type: "tool",
          id: event.toolUseId,
          name: event.name,
          input: event.input,
          agentId: event.agentId,
          done: false,
        },
      ];

    case "tool.end": {
      const index = blocks.findIndex((b) => b.type === "tool" && b.id === event.toolUseId);
      if (index === -1) return blocks;
      const next = [...blocks];
      next[index] = {
        ...(next[index] as Extract<Block, { type: "tool" }>),
        result: event.content,
        isError: event.isError,
        done: true,
      };
      return next;
    }

    case "turn.end": {
      // No `thinking.done` event exists: a finished turn is what settles its
      // thinking folds, so they stop reading as still-running ("생각 중").
      const settled = blocks.map((block) =>
        block.type === "thinking" && block.streaming ? { ...block, streaming: false } : block,
      );
      return [
        ...settled,
        {
          type: "turn",
          id: `t${++noticeSeq}`,
          subtype: event.subtype,
          isError: event.isError,
          costUsd: event.costUsd,
          durationMs: event.durationMs,
        },
      ];
    }

    case "retry":
      return [
        ...blocks,
        {
          type: "notice",
          id: `n${++noticeSeq}`,
          level: "warn",
          text:
            event.error === "rate_limit"
              ? `구독 사용량을 채웠습니다 — ${Math.round(event.delayMs / 1000)}초 후에 다시 시도해요 (${event.attempt}/${event.maxRetries}).`
              : `${event.error} 오류로 잠시 멈췄습니다 — ${Math.round(event.delayMs / 1000)}초 후에 다시 시도해요.`,
        },
      ];

    case "notice":
      return [
        ...blocks,
        { type: "notice", id: `n${++noticeSeq}`, level: event.level, text: event.text },
      ];

    case "compact":
      return [
        ...blocks,
        {
          type: "notice",
          id: `n${++noticeSeq}`,
          level: "info",
          text: `Earlier context was compacted (${event.trigger}).`,
        },
      ];

    case "init":
      return blocks;
  }
}

// ---------------------------------------------------------------------------
// Pending human-in-the-loop requests
// ---------------------------------------------------------------------------

export interface PendingPermission {
  kind: "permission";
  requestId: string;
  sessionId: string;
  toolName: string;
  input: unknown;
  suggestions: PermissionSuggestion[];
}

export interface PendingQuestion {
  kind: "question";
  requestId: string;
  sessionId: string;
  questions: AskQuestion[];
}

export type Pending = PendingPermission | PendingQuestion;

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export type ConnectionState = "idle" | "connecting" | "open" | "closed" | "error";

interface SessionView {
  blocks: Block[];
  state: SessionState;
  model: string | null;
  /** True once this daemon holds a live query for the session. */
  live: boolean;
}

const EMPTY_SESSION: SessionView = {
  blocks: [],
  state: "idle",
  model: null,
  live: false,
};

/** Requests the UI can make. Every method resolves with the daemon's reply. */
export interface DaemonApi {
  /**
   * `pageId` narrows the list to the threads attached to one 기획서 page;
   * omit it for every thread of the workspace, which is what a caller with no
   * page open (설정 dialog) wants.
   */
  listSessions: (workspace: Workspace, pageId?: string) => Promise<SessionSummary[]>;
  history: (sessionId: string) => Promise<ChatEvent[]>;
  /**
   * Omit `resume` for a fresh thread in that workspace. `model` and `effort`
   * carry the composer's chips into the new session — the daemon otherwise
   * starts every thread on the CLI's own defaults. `pageId` attaches the
   * thread to the page it was started from, so it comes back with that page.
   */
  createSession: (
    workspace: Workspace,
    opts?: { resume?: string; model?: string; effort?: EffortLevel; pageId?: string; title?: string },
  ) => Promise<{ sessionId: string }>;
  send: (
    sessionId: string,
    text: string,
    images?: Array<{ mediaType: string; data: string }>,
    files?: Array<{ name: string; mediaType: string; data: string }>,
  ) => Promise<unknown>;
  interrupt: (sessionId: string) => Promise<unknown>;
  contextUsage: (sessionId: string) => Promise<ContextUsage | null>;
  /** 모델·노력·권한 chips; switches apply from the next response. */
  selectors: (sessionId: string) => Promise<SessionSelectors>;
  /** The /command palette rows. */
  commands: (sessionId: string) => Promise<SessionCommand[]>;
  setModel: (sessionId: string, model: string | null) => Promise<unknown>;
  setEffort: (sessionId: string, effort: EffortLevel | null) => Promise<unknown>;
  setPermissionMode: (sessionId: string, mode: PermissionMode) => Promise<unknown>;
  /** @-mention autocomplete, over the file set the workspace can see. */
  findFiles: (workspace: Workspace, query: string, limit?: number) => Promise<string[]>;
  closeSession: (sessionId: string) => Promise<unknown>;
  deleteSession: (sessionId: string) => Promise<unknown>;
  respondPermission: (
    requestId: string,
    decision: "allow" | "allowAlways" | "deny",
    message?: string,
  ) => Promise<unknown>;
  respondQuestion: (requestId: string, answers: Record<string, string | string[]>) => Promise<unknown>;
  refreshStatus: () => Promise<void>;
  /**
   * The registry, asked for on connect. `hello` already carries it, so the
   * switcher only needs this after a change it did not see broadcast.
   */
  projectList: () => Promise<ProjectList>;
  /**
   * Register a project and bring it up: clone the repo, mirror the subtrees.
   * Resolves with the created project; progress arrives as `repo.status` and
   * `confluence.status`.
   */
  projectCreate: (input: {
    name: string;
    roots: Array<{ space: string; rootPageId: string | null }>;
    repoUrl: string | null;
    repoPat?: string | null;
    baseBranch?: string;
  }) => Promise<ProjectSummary>;
  /** Switch which project everything else means. */
  projectActivate: (slug: string) => Promise<ProjectList>;
  /** Rename, or re-point the repo url/PAT/base branch (write-only PAT). */
  projectUpdate: (
    slug: string,
    changes: { name?: string; repoUrl?: string | null; repoPat?: string | null; baseBranch?: string },
  ) => Promise<ProjectList>;
  /** Forget a project; its folder survives unless `deleteFiles`. */
  projectRemove: (slug: string, deleteFiles?: boolean) => Promise<ProjectList>;
  repoStatus: () => Promise<RepoStatus>;
  /** Clone when missing, pull, install when needed, start the preview. */
  repoSync: () => Promise<RepoStatus>;
  /** Change the connected repo's url and/or PAT (write-only). */
  repoUpdate: (url: string | null, pat?: string | null) => Promise<RepoStatus>;
  /** Worktree changes not saved yet, for the 저장 review panel. */
  diff: () => Promise<DiffFile[]>;
  /**
   * 저장 (PLAN D5): run the gates, then commit and push onto this cycle's own
   * `drafthouse/…` branch. Progress arrives as `diff.status`.
   */
  save: (message?: string, sessionId?: string | null) => Promise<DiffStatus>;
  /**
   * 개발자에게 넘기기: the `build` gate, then open (or update) the pull request
   * for the saved branch. Progress arrives as `diff.status` like a save does.
   */
  handoff: (input: { title?: string; body?: string; sessionId?: string | null }) => Promise<DiffStatus>;
  /**
   * Re-read the handed-off request from GitHub. Asked for by the planner, never
   * polled — the state only moves when a developer acts on it.
   */
  handoffStatus: () => Promise<HandoffStatus>;
  confluenceStatus: () => Promise<{
    settings: ConfluenceSettings;
    spaces: ConfluenceStatus[];
  }>;
  /** Credentials go daemon-side (OS store); the reply carries presence only. */
  confluenceUpdate: (
    siteUrl: string | null,
    email: string | null,
    apiToken?: string | null,
  ) => Promise<ConfluenceSettings>;
  /** Remote spaces plus the keys already mirrored, for the clone picker. */
  confluenceSpaces: () => Promise<ConfluenceSpaceList>;
  /**
   * The remote page tree of a space, for the project wizard's root picker.
   * Nothing is mirrored at that point — this reads Confluence directly.
   */
  confluencePageTree: (space: string) => Promise<ConfluencePageTree>;
  /**
   * Clone a whole space into the mirror. Not a first-run-only action: the
   * + 스페이스 flow and a re-take of a clone that died halfway both land here.
   */
  confluenceSync: (space: string) => Promise<ConfluenceStatus>;
  /** What 게시 would send, for the confirm dialog — computed, nothing written. */
  confluenceReview: (space: string) => Promise<ConfluenceReview>;
  /** Pull one mirrored space now; progress arrives as `confluence.status`. */
  confluencePull: (space: string) => Promise<ConfluenceStatus>;
  /** Push a mirrored space's local edits back to Confluence. */
  confluencePush: (space: string) => Promise<ConfluenceStatus>;
  docList: (space: string) => Promise<DocSummary[]>;
  docOpen: (path: string) => Promise<DocState>;
  /** The single save path — the daemon normalizes and writes. */
  docSave: (path: string, markdown: string) => Promise<DocSaved>;
  docResolve: (path: string, choice: "mine" | "theirs") => Promise<DocSaved>;
  docAttachmentSave: (path: string, filename: string, mediaType: string, data: string) => Promise<{ filename: string; reference: string; mediaType: string }>;
  docLock: (locked: boolean, reason?: string) => Promise<DocLock>;
  /** Hold/release a background-pull deferral for unsaved editor work. */
  docEditing: (path: string, editing: boolean) => Promise<unknown>;
  /** The four onboarding checks; read-only. */
  onboardingCheck: () => Promise<OnboardingStep[]>;
  /** Run a fix; resolves with whatever the fix returns (status/guidance). */
  onboardingFix: (kind: OnboardingFixKind, space?: string) => Promise<unknown>;
}

/** One connection to one daemon, as the views consume it. */
export interface Daemon {
  connection: ConnectionState;
  connectionError: string | null;
  status: DaemonStatus | null;
  /**
   * Every registered project, and which one everything else means. Seeded
   * from `hello`, re-pointed by `project.changed` — two windows on one daemon
   * must never disagree about what they are showing.
   */
  projects: ProjectSummary[];
  activeSlug: string | null;
  sessions: Record<string, SessionView>;
  pending: Pending[];
  api: DaemonApi;
  /** Connected repo state; null until the daemon has reported it once. */
  repo: RepoStatus | null;
  /**
   * Where the current 저장 or 넘기기 stands; null until one starts. Both share
   * one channel — the daemon runs one at a time against one clone.
   */
  diffStatus: DiffStatus | null;
  /** Mirror state; spaces appear as they are cloned. */
  confluenceStatuses: ConfluenceStatus[];
  confluenceSettings: ConfluenceSettings | null;
  /** Last mirror-file change broadcast; editors reload on their own path. */
  docChanged: { path: string; at: number } | null;
  /** Editor lock: true while a Claude turn runs or a client holds doc.lock. */
  docLock: DocLock | null;
  /** Latest onboarding checks; null until first check returns. */
  onboarding: OnboardingStep[] | null;
  resolvePending: (requestId: string) => void;
  ensureSession: (sessionId: string) => void;
  hydrate: (sessionId: string, events: ChatEvent[]) => void;
  markLive: (sessionId: string) => void;
}

export function useDaemon(url: string | null): Daemon {
  const socket = useRef<WebSocket | null>(null);
  const pendingCalls = useRef(new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>());
  const counter = useRef(0);

  const [connection, setConnection] = useState<ConnectionState>("idle");
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [status, setStatus] = useState<DaemonStatus | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Record<string, SessionView>>({});
  const [pending, setPending] = useState<Pending[]>([]);
  const [repo, setRepo] = useState<RepoStatus | null>(null);
  const [diffStatus, setDiffStatus] = useState<DiffStatus | null>(null);
  const [confluenceStatuses, setConfluenceStatuses] = useState<ConfluenceStatus[]>([]);
  const [confluenceSettings, setConfluenceSettings] = useState<ConfluenceSettings | null>(null);
  const [docChanged, setDocChanged] = useState<{ path: string; at: number } | null>(null);
  const [docLock, setDocLock] = useState<DocLock | null>(null);
  const [onboarding, setOnboarding] = useState<OnboardingStep[] | null>(null);

  useEffect(() => {
    if (!url) return;
    setConnection("connecting");
    setConnectionError(null);

    let ws: WebSocket | null = null;
    let disposed = false;
    let everOpen = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const flushPending = () => {
      for (const call of pendingCalls.current.values()) call.reject(new Error("connection lost"));
      pendingCalls.current.clear();
    };

    const connect = () => {
      if (disposed) return;
      setConnection("connecting");
      let sock: WebSocket;
      try {
        sock = new WebSocket(url);
      } catch (error) {
        setConnection("error");
        setConnectionError(error instanceof Error ? error.message : "invalid daemon url");
        return;
      }
      ws = sock;
      socket.current = sock;

      sock.onopen = () => {
        if (disposed) {
          sock.close();
          return;
        }
        everOpen = true;
        attempt = 0;
        setConnection("open");
      };
      sock.onerror = () => {
        // A dead socket always closes right after; the reconnect decision
        // lives in onclose so nothing has to be duplicated here.
      };
      sock.onclose = () => {
        socket.current = null;
        if (disposed) return;
        flushPending();
        if (!everOpen) {
          // First attempt never got in: most likely a wrong url or the daemon
          // is genuinely down. Show the connect screen; the retry below still
          // brings the app back if the daemon appears afterwards.
          setConnection("error");
          setConnectionError("Could not reach the daemon. Is it running?");
        }
        const delay = Math.min(1000 * 2 ** attempt, 5000);
        attempt += 1;
        retryTimer = setTimeout(connect, delay);
      };

      sock.onmessage = handleMessage;
    };

    const handleMessage = (raw: MessageEvent) => {
      const message = JSON.parse(raw.data as string) as ServerMessage;

      if (message.type === "ok" || message.type === "error") {
        const call = pendingCalls.current.get(message.id ?? "");
        if (call) {
          pendingCalls.current.delete(message.id!);
          if (message.type === "ok") call.resolve(message.data);
          else call.reject(new Error(message.message));
        }
        return;
      }

      if (message.type === "hello" || message.type === "status") {
        setStatus(message.status);
        // Status carries the registry, so a reconnect re-points the switcher
        // without a round trip of its own.
        setProjects(message.status.projects);
        setActiveSlug(message.status.activeProject);
        return;
      }

      if (message.type === "project.changed") {
        setProjects(message.projects);
        setActiveSlug(message.activeSlug);
        return;
      }

      if (message.type === "repo.status") {
        setRepo(message.status);
        return;
      }

      if (message.type === "diff.status") {
        setDiffStatus(message.status);
        return;
      }

      if (message.type === "confluence.status") {
        setConfluenceStatuses((prev) => {
          const next = prev.filter((status) => status.space !== message.status.space);
          return message.status.space ? [...next, message.status] : next;
        });
        return;
      }

      if (message.type === "doc.changed") {
        setDocChanged({ path: message.path, at: Date.now() });
        return;
      }

      if (message.type === "doc.locked") {
        setDocLock(message.lock);
        return;
      }

      if (message.type === "session.event") {
        setSessions((prev) => {
          const view = prev[message.sessionId] ?? EMPTY_SESSION;
          const next: SessionView =
            message.event.kind === "init"
              ? { ...view, model: message.event.model }
              : { ...view, blocks: foldEvent(view.blocks, message.event) };
          return { ...prev, [message.sessionId]: next };
        });
        return;
      }

      if (message.type === "session.state") {
        setSessions((prev) => ({
          ...prev,
          [message.sessionId]: { ...(prev[message.sessionId] ?? EMPTY_SESSION), state: message.state },
        }));
        return;
      }

      if (message.type === "permission.request") {
        const entry: PendingPermission = {
          kind: "permission",
          requestId: message.requestId,
          sessionId: message.sessionId,
          toolName: message.toolName,
          input: message.input,
          suggestions: message.suggestions,
        };
        setPending((prev) => [...prev, entry]);
        return;
      }

      if (message.type === "question.request") {
        const entry: PendingQuestion = {
          kind: "question",
          requestId: message.requestId,
          sessionId: message.sessionId,
          questions: message.questions,
        };
        setPending((prev) => [...prev, entry]);
      }
    };

    connect();

    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (ws) {
        ws.onclose = null;
        ws.onmessage = null;
        ws.close();
      }
      socket.current = null;
    };
  }, [url]);

  const call = useCallback(<T,>(payload: Record<string, unknown>, timeoutMs = 60_000): Promise<T> => {
    const ws = socket.current;
    if (!ws || ws.readyState !== ws.OPEN) return Promise.reject(new Error("not connected"));
    const id = `c${++counter.current}`;
    return new Promise<T>((resolve, reject) => {
      pendingCalls.current.set(id, { resolve: resolve as (v: unknown) => void, reject });
      ws.send(JSON.stringify({ id, ...payload }));
      setTimeout(() => {
        if (pendingCalls.current.delete(id)) reject(new Error("daemon did not respond"));
      }, timeoutMs);
    });
  }, []);

  /** Keep the reply of a repo request as state, so a caller gets both. */
  const keepRepo = useCallback((next: RepoStatus) => {
    setRepo(next);
    return next;
  }, []);

  /**
   * Keep a registry reply as state. The reply and its `project.changed`
   * broadcast race, and whichever lands second carries the same registry.
   */
  const keepProjects = useCallback((next: ProjectList) => {
    setProjects(next.projects);
    setActiveSlug(next.activeSlug);
    return next;
  }, []);

  const api = useMemo<DaemonApi>(
    () => ({
      listSessions: (workspace: Workspace, pageId?: string) =>
        call<SessionSummary[]>({ type: "session.list", workspace, ...(pageId ? { pageId } : {}) }),
      history: (sessionId: string) => call<ChatEvent[]>({ type: "session.history", sessionId }),
      createSession: (
        workspace: Workspace,
        opts?: { resume?: string; model?: string; effort?: EffortLevel; pageId?: string; title?: string },
      ) =>
        call<{ sessionId: string }>({
          type: "session.create",
          workspace,
          ...(opts?.resume ? { resume: opts.resume } : {}),
          ...(opts?.model ? { model: opts.model } : {}),
          ...(opts?.effort ? { effort: opts.effort } : {}),
          ...(opts?.pageId ? { pageId: opts.pageId } : {}),
          ...(opts?.title ? { title: opts.title } : {}),
        }),
      send: (
        sessionId: string,
        text: string,
        images?: Array<{ mediaType: string; data: string }>,
        files?: Array<{ name: string; mediaType: string; data: string }>,
      ) =>
        call({
          type: "session.send",
          sessionId,
          text,
          ...(images?.length ? { images } : {}),
          ...(files?.length ? { files } : {}),
        }),
      interrupt: (sessionId: string) => call({ type: "session.interrupt", sessionId }),
      contextUsage: (sessionId: string) =>
        call<ContextUsage | null>({ type: "session.contextUsage", sessionId }),
      selectors: (sessionId: string) => call<SessionSelectors>({ type: "session.selectors", sessionId }),
      commands: (sessionId: string) => call<SessionCommand[]>({ type: "session.commands", sessionId }),
      setModel: (sessionId: string, model: string | null) =>
        call({ type: "session.setModel", sessionId, model }),
      setEffort: (sessionId: string, effort: EffortLevel | null) =>
        call({ type: "session.setEffort", sessionId, effort }),
      setPermissionMode: (sessionId: string, mode: PermissionMode) =>
        call({ type: "session.setPermissionMode", sessionId, mode }),
      findFiles: (workspace: Workspace, query: string, limit = 40) =>
        call<string[]>({ type: "repo.files", workspace, query, limit }),
      closeSession: (sessionId: string) => call({ type: "session.close", sessionId }),
      deleteSession: (sessionId: string) => call({ type: "session.delete", sessionId }),
      respondPermission: (requestId: string, decision: "allow" | "allowAlways" | "deny", message?: string) =>
        call({ type: "permission.respond", requestId, decision, message }),
      respondQuestion: (requestId: string, answers: Record<string, string | string[]>) =>
        call({ type: "question.respond", requestId, answers }),
      refreshStatus: () => call<DaemonStatus>({ type: "daemon.status" }).then(setStatus),
      projectList: () => call<ProjectList>({ type: "project.list" }).then(keepProjects),
      // Creating clones the repo AND mirrors every root: a first run downloads
      // two trees, so it gets more than the minutes a single clone does.
      projectCreate: (input: {
        name: string;
        roots: Array<{ space: string; rootPageId: string | null }>;
        repoUrl: string | null;
        repoPat?: string | null;
        baseBranch?: string;
      }) =>
        call<ProjectSummary>(
          {
            type: "project.create",
            name: input.name,
            roots: input.roots,
            repoUrl: input.repoUrl,
            ...(input.repoPat !== undefined ? { repoPat: input.repoPat } : {}),
            ...(input.baseBranch ? { baseBranch: input.baseBranch } : {}),
          },
          900_000,
        ),
      // Activating stops one preview server and starts another, and the
      // incoming project may still need its clone or install.
      projectActivate: (slug: string) =>
        call<ProjectList>({ type: "project.activate", slug }, 600_000).then(keepProjects),
      projectUpdate: (
        slug: string,
        changes: { name?: string; repoUrl?: string | null; repoPat?: string | null; baseBranch?: string },
      ) =>
        call<ProjectList>(
          {
            type: "project.update",
            slug,
            ...(changes.name !== undefined ? { name: changes.name } : {}),
            ...(changes.repoUrl !== undefined ? { repoUrl: changes.repoUrl } : {}),
            ...(changes.repoPat !== undefined ? { repoPat: changes.repoPat } : {}),
            ...(changes.baseBranch !== undefined ? { baseBranch: changes.baseBranch } : {}),
          },
          // A moved url re-clones.
          600_000,
        ).then(keepProjects),
      projectRemove: (slug: string, deleteFiles?: boolean) =>
        call<ProjectList>(
          { type: "project.remove", slug, ...(deleteFiles ? { deleteFiles } : {}) },
          120_000,
        ).then(keepProjects),
      repoStatus: () => call<RepoStatus>({ type: "repo.status" }).then(keepRepo),
      // A first run clones and installs the connected repo: minutes, not the
      // minute a normal request is given before it is declared lost.
      repoSync: () => call<RepoStatus>({ type: "repo.sync" }, 600_000).then(keepRepo),
      repoUpdate: (url: string | null, pat?: string | null) =>
        call<RepoStatus>(
          {
            type: "repo.update",
            ...(url !== undefined ? { url } : {}),
            ...(pat !== undefined ? { pat } : {}),
          },
          600_000,
        ).then(keepRepo),
      diff: () => call<DiffFile[]>({ type: "diff.get" }, 120_000),
      // A save runs the repo's own check and build before pushing: the
      // same minutes a first sync is given.
      save: (message?: string, sessionId?: string | null) =>
        call<DiffStatus>(
          {
            type: "repo.save",
            ...(message ? { message } : {}),
            ...(sessionId ? { sessionId } : {}),
          },
          600_000,
        ),
      // A handoff is a gate plus a network write: the repo's `build` runs
      // first, and only then does the pull request go out. Same window as a
      // save, because the gate is the slow half of both.
      handoff: (input: { title?: string; body?: string; sessionId?: string | null }) =>
        call<DiffStatus>(
          {
            type: "repo.handoff",
            ...(input.title ? { title: input.title } : {}),
            ...(input.body ? { body: input.body } : {}),
            ...(input.sessionId ? { sessionId: input.sessionId } : {}),
          },
          600_000,
        ),
      // One read of one pull request — no gate, no push. The window a remote
      // read gets, not the one a transfer does.
      handoffStatus: () => call<HandoffStatus>({ type: "repo.handoffStatus" }, 120_000),
      confluenceStatus: () =>
        call<{ settings: ConfluenceSettings; spaces: ConfluenceStatus[] }>({ type: "confluence.status" }).then(
          (data) => {
            setConfluenceSettings(data.settings);
            // The reply is the mirror's snapshot; `confluence.status`
            // broadcasts only report CHANGES. Dropping it left an already
            // mirrored space invisible after every app start — an empty page
            // tree until some space happened to move.
            setConfluenceStatuses(data.spaces);
            return data;
          },
        ),
      confluenceUpdate: (siteUrl: string | null, email: string | null, apiToken?: string | null) =>
        call<ConfluenceSettings>(
          {
            type: "confluence.update",
            ...(siteUrl !== undefined ? { siteUrl } : {}),
            ...(email !== undefined ? { email } : {}),
            ...(apiToken !== undefined ? { apiToken } : {}),
          },
          120_000,
        ).then((settings) => {
          setConfluenceSettings(settings);
          return settings;
        }),
      // Listing spaces walks the site's cursor pages; a large site is slower
      // than a status call, well short of a transfer.
      confluenceSpaces: () => call<ConfluenceSpaceList>({ type: "confluence.spaces" }, 120_000),
      // Listing a whole space's pages is one paginated read; the picker cannot
      // open until it lands, so it gets the same window as the space list.
      confluencePageTree: (space: string) =>
        call<ConfluencePageTree>({ type: "confluence.pageTree", space }, 120_000),
      // A clone downloads every page and attachment of a space: the same
      // minutes a push gets, not the minute a normal request does.
      confluenceSync: (space: string) =>
        call<ConfluenceStatus>({ type: "confluence.sync", space }, 600_000),
      confluencePull: (space: string) =>
        call<ConfluenceStatus>({ type: "confluence.pull", space }, 300_000),
      confluenceReview: (space: string) => call<ConfluenceReview>({ type: "confluence.review", space }),
      // A push creates pages and uploads attachments one page at a time; a
      // large space takes minutes, not the minute a normal request gets.
      confluencePush: (space: string) =>
        call<ConfluenceStatus>({ type: "confluence.push", space }, 600_000),
      docList: (space: string) => call<DocSummary[]>({ type: "doc.list", space }),
      docOpen: (path: string) => call<DocState>({ type: "doc.open", path }),
      docSave: (path: string, markdown: string) =>
        call<DocSaved>({ type: "doc.save", path, markdown }, 120_000),
      docResolve: (path: string, choice: "mine" | "theirs") =>
        call<DocSaved>({ type: "doc.resolve", path, choice }),
      docAttachmentSave: (path: string, filename: string, mediaType: string, data: string) =>
        call<{ filename: string; reference: string; mediaType: string }>({
          type: "doc.attachment.save",
          path,
          filename,
          mediaType,
          data,
        }),
      docLock: (locked: boolean, reason?: string) =>
        call<DocLock>({ type: "doc.lock", locked, ...(reason ? { reason } : {}) }),
      docEditing: (path: string, editing: boolean) =>
        call({ type: "doc.editing", path, editing }),
      onboardingCheck: () =>
        call<OnboardingStep[]>({ type: "onboarding.check" }, 120_000).then((steps) => {
          setOnboarding(steps);
          return steps;
        }),
      onboardingFix: (kind: OnboardingFixKind, space?: string) =>
        call(
          { type: "onboarding.fix", kind, ...(space ? { space } : {}) },
          // repo-install and confluence-sync clone and install.
          600_000,
        ).then(async (data) => {
          try {
            setOnboarding(await call<OnboardingStep[]>({ type: "onboarding.check" }, 120_000));
          } catch {
            // the wizard re-checks on its own
          }
          return data;
        }),
    }),
    [call, keepProjects, keepRepo],
  );

  const resolvePending = useCallback((requestId: string) => {
    setPending((prev) => prev.filter((p) => p.requestId !== requestId));
  }, []);

  const ensureSession = useCallback((sessionId: string) => {
    setSessions((prev) => (prev[sessionId] ? prev : { ...prev, [sessionId]: EMPTY_SESSION }));
  }, []);

  /** Replace a session's transcript with a stored one, without resuming it. */
  const hydrate = useCallback((sessionId: string, events: ChatEvent[]) => {
    setSessions((prev) => ({
      ...prev,
      [sessionId]: {
        ...(prev[sessionId] ?? EMPTY_SESSION),
        blocks: events.reduce<Block[]>(foldEvent, []),
      },
    }));
  }, []);

  const markLive = useCallback((sessionId: string) => {
    setSessions((prev) => ({
      ...prev,
      [sessionId]: { ...(prev[sessionId] ?? EMPTY_SESSION), live: true },
    }));
  }, []);

  return {
    connection,
    connectionError,
    status,
    projects,
    activeSlug,
    sessions,
    pending,
    api,
    resolvePending,
    ensureSession,
    hydrate,
    markLive,
    repo,
    diffStatus,
    confluenceStatuses,
    confluenceSettings,
    docChanged,
    docLock,
    onboarding,
  };
}

export { EMPTY_SESSION };
export type { SessionView };
