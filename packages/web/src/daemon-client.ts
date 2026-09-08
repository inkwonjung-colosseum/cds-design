import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AskQuestion,
  ChatEvent,
  ContextUsage,
  DaemonStatus,
  PermissionSuggestion,
  RepoStatus,
  ServerMessage,
  SessionSummary,
} from "@agent-hub/protocol";

// ---------------------------------------------------------------------------
// Transcript model: ChatEvents folded into renderable blocks
// ---------------------------------------------------------------------------

export type Block =
  | { type: "user"; id: string; text: string; images: number; files: string[] }
  | { type: "text"; id: string; text: string; agentId: string | null; streaming: boolean }
  | { type: "thinking"; id: string; text: string; agentId: string | null }
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
          { type: "thinking", id: event.blockId, text: event.text, agentId: event.agentId },
        ];
      }
      const next = [...blocks];
      const current = next[index] as Extract<Block, { type: "thinking" }>;
      next[index] = { ...current, text: current.text + event.text };
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

    case "turn.end":
      return [
        ...blocks,
        {
          type: "turn",
          id: `t${++noticeSeq}`,
          subtype: event.subtype,
          isError: event.isError,
          costUsd: event.costUsd,
          durationMs: event.durationMs,
        },
      ];

    case "retry":
      return [
        ...blocks,
        {
          type: "notice",
          id: `n${++noticeSeq}`,
          level: "warn",
          text:
            event.error === "rate_limit"
              ? `Subscription limit reached. Retrying in ${Math.round(event.delayMs / 1000)}s (attempt ${event.attempt}/${event.maxRetries}).`
              : `Retrying after ${event.error} in ${Math.round(event.delayMs / 1000)}s.`,
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
  state: string;
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
  listSessions: () => Promise<SessionSummary[]>;
  history: (sessionId: string) => Promise<ChatEvent[]>;
  /** Omit `resume` for a fresh planning thread. */
  createSession: (resume?: string) => Promise<{ sessionId: string }>;
  send: (
    sessionId: string,
    text: string,
    images?: Array<{ mediaType: string; data: string }>,
    files?: Array<{ name: string; mediaType: string; data: string }>,
  ) => Promise<unknown>;
  interrupt: (sessionId: string) => Promise<unknown>;
  contextUsage: (sessionId: string) => Promise<ContextUsage | null>;
  findFiles: (query: string, limit?: number) => Promise<string[]>;
  closeSession: (sessionId: string) => Promise<unknown>;
  deleteSession: (sessionId: string) => Promise<unknown>;
  respondPermission: (
    requestId: string,
    decision: "allow" | "allowAlways" | "deny",
    message?: string,
  ) => Promise<unknown>;
  respondQuestion: (requestId: string, answers: Record<string, string | string[]>) => Promise<unknown>;
  refreshStatus: () => Promise<void>;
  repoStatus: () => Promise<RepoStatus>;
  /** Clone when missing, pull, install when needed, start the preview. */
  repoSync: () => Promise<RepoStatus>;
  /** Change the connected repo's url and/or PAT (write-only). */
  repoUpdate: (url: string | null, pat?: string | null) => Promise<RepoStatus>;
}

/** One connection to one daemon, as the views consume it. */
export interface Daemon {
  connection: ConnectionState;
  connectionError: string | null;
  status: DaemonStatus | null;
  sessions: Record<string, SessionView>;
  pending: Pending[];
  api: DaemonApi;
  /** Connected repo state; null until the daemon has reported it once. */
  repo: RepoStatus | null;
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
  const [sessions, setSessions] = useState<Record<string, SessionView>>({});
  const [pending, setPending] = useState<Pending[]>([]);
  const [repo, setRepo] = useState<RepoStatus | null>(null);

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
        return;
      }

      if (message.type === "repo.status") {
        setRepo(message.status);
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

  const api = useMemo<DaemonApi>(
    () => ({
      listSessions: () => call<SessionSummary[]>({ type: "session.list" }),
      history: (sessionId: string) => call<ChatEvent[]>({ type: "session.history", sessionId }),
      createSession: (resume?: string) =>
        call<{ sessionId: string }>({ type: "session.create", ...(resume ? { resume } : {}) }),
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
      findFiles: (query: string, limit = 40) =>
        call<string[]>({ type: "repo.files", query, limit }),
      closeSession: (sessionId: string) => call({ type: "session.close", sessionId }),
      deleteSession: (sessionId: string) => call({ type: "session.delete", sessionId }),
      respondPermission: (requestId: string, decision: "allow" | "allowAlways" | "deny", message?: string) =>
        call({ type: "permission.respond", requestId, decision, message }),
      respondQuestion: (requestId: string, answers: Record<string, string | string[]>) =>
        call({ type: "question.respond", requestId, answers }),
      refreshStatus: () => call<DaemonStatus>({ type: "daemon.status" }).then(setStatus),
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
    }),
    [call, keepRepo],
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
    sessions,
    pending,
    api,
    resolvePending,
    ensureSession,
    hydrate,
    markLive,
    repo,
  };
}

export { EMPTY_SESSION };
export type { SessionView };
