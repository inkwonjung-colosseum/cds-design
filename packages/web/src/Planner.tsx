import { useCallback, useEffect, useRef, useState } from "react";
import type { ContextUsage, RepoPhase, SessionSummary } from "@agent-hub/protocol";
import { EMPTY_SESSION, type Daemon } from "./daemon-client";
import { PermissionCard, QuestionCard, Transcript } from "./components";
import { Composer, type Attachment } from "./Composer";
import { Preview } from "./Preview";
import type { SendKey } from "./settings";
import { CloseIcon, GearIcon } from "./icons";

const PHASE_LABEL: Record<RepoPhase, string> = {
  missing: "연결 레포를 연결해 주세요",
  cloning: "연결 레포를 내려받는 중",
  pulling: "연결 레포의 최신 변경사항을 받아 오는 중",
  installing: "의존성 설치 중 — 처음 한 번만, 1~2분 걸립니다",
  starting: "미리보기 서버를 켜는 중",
  ready: "준비 완료",
  error: "준비하지 못했습니다",
};

/** Session rows read as "얼마 전"; an exact date only helps once it is old. */
function timeAgo(ts: number): string {
  const seconds = Math.max(0, (Date.now() - ts) / 1000);
  if (seconds < 60) return "방금";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}분 전`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}시간 전`;
  if (seconds < 7 * 86400) return `${Math.floor(seconds / 86400)}일 전`;
  return new Date(ts).toLocaleDateString();
}

interface Guidance {
  title: string;
  body: string;
  /** A command the planner can paste into a terminal, if one would fix this. */
  command?: string;
}

/**
 * Which failure this is. A dead preview server leaves the chat usable, so it
 * is answered in the preview column; everything else replaces the workspace.
 */
type ErrorKind = "auth" | "pnpm" | "preview" | "unknown";

function classifyError(detail: string | null): ErrorKind {
  if (detail?.includes("GitHub 패키지 인증")) return "auth";
  if (detail?.includes("pnpm이 없습니다")) return "pnpm";
  if (detail?.includes("미리보기 서버가 종료")) return "preview";
  return "unknown";
}

function guidanceFor(kind: ErrorKind, detail: string | null): Guidance {
  if (kind === "auth") {
    return {
      title: "GitHub 패키지 인증이 필요합니다",
      body: "연결 레포의 의존성을 사내 GitHub 패키지에서 받아옵니다. 설정의 개인 액세스 토큰(read:packages 권한)을 확인한 뒤 다시 시도해 주세요.",
      command: "pnpm config set //npm.pkg.github.com/:_authToken <PAT>",
    };
  }
  if (kind === "pnpm") {
    return {
      title: "pnpm이 설치되어 있지 않습니다",
      body: "연결 레포의 설치·미리보기에 pnpm이 필요합니다. 터미널에 아래 명령을 실행한 뒤 다시 시도해 주세요.",
      command: "corepack enable",
    };
  }
  return {
    title: "준비하지 못했습니다",
    body: detail ?? "원인을 알 수 없습니다. 다시 시도해 주세요.",
  };
}

function ProgressPanel({
  phase,
  detail,
  errorKind,
  onRetry,
  onOpenSettings,
}: {
  phase: RepoPhase;
  detail: string | null;
  errorKind: ErrorKind;
  onRetry: () => void;
  onOpenSettings: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const failed = phase === "error";
  const guidance = failed ? guidanceFor(errorKind, detail) : null;
  const needsSetup = phase === "missing";

  const copy = async (command: string) => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard can be blocked; the command is visible to retype anyway.
    }
  };

  return (
    <div className={failed ? "progress progress--error" : "progress"}>
      <div className="progress__head">
        {!failed && <span className="spinner" />}
        <h2>{guidance ? guidance.title : PHASE_LABEL[phase]}</h2>
      </div>
      <p className="progress__body">
        {guidance
          ? guidance.body
          : needsSetup
            ? "설정에서 연결 레포 주소와 개인 액세스 토큰을 입력해 주세요."
            : "처음 한 번만 준비하면, 다음부터는 바로 시작합니다."}
      </p>
      {guidance?.command && (
        <pre className="progress__cmd">
          <code>{guidance.command}</code>
          <button type="button" className="ghost" onClick={() => void copy(guidance.command!)}>
            {copied ? "복사됨 ✓" : "복사"}
          </button>
        </pre>
      )}
      {!failed && detail && <div className="progress__detail">{detail}</div>}
      {failed && (
        <button type="button" className="primary" onClick={onRetry}>
          다시 시도
        </button>
      )}
      {!failed && needsSetup && (
        <button type="button" className="primary" onClick={onOpenSettings}>
          설정 열기
        </button>
      )}
    </div>
  );
}

export function Planner({
  daemon,
  sendKey,
  confirmBeforeDelete,
  onOpenSettings,
}: {
  daemon: Daemon;
  sendKey: SendKey;
  /** Ask before a delete removes the transcript for good. */
  confirmBeforeDelete: boolean;
  onOpenSettings: () => void;
}) {
  const {
    connection,
    repo,
    status,
    api,
    sessions,
    pending,
    ensureSession,
    hydrate,
    markLive,
    resolvePending,
  } = daemon;

  const [sessionList, setSessionList] = useState<SessionSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [usage, setUsage] = useState<ContextUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const root = repo?.root ?? null;
  const phase = repo?.phase ?? null;
  const active = activeId ? (sessions[activeId] ?? EMPTY_SESSION) : null;
  const running = active?.state === "running";

  const sync = useCallback(() => {
    setError(null);
    void api.repoSync().catch((e: Error) => setError(e.message));
  }, [api]);

  const refreshSessions = useCallback(async () => {
    setSessionList(await api.listSessions().catch(() => [] as SessionSummary[]));
  }, [api]);

  useEffect(() => {
    if (connection !== "open") return;
    sync();
  }, [connection, sync]);

  useEffect(() => {
    if (connection !== "open" || phase !== "ready") return;
    void refreshSessions();
  }, [connection, phase, refreshSessions]);

  // One planner session per thread of work; open one as soon as the workspace
  // can serve it, so the planner's first message has somewhere to land.
  useEffect(() => {
    if (connection !== "open" || phase !== "ready" || activeId) return;
    let cancelled = false;
    void api
      .createSession()
      .then(({ sessionId }) => {
        if (cancelled) return;
        ensureSession(sessionId);
        markLive(sessionId);
        setActiveId(sessionId);
      })
      .catch((e: Error) => setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [connection, phase, activeId, api, ensureSession, markLive]);

  // Follow the conversation as it grows, so a long answer does not scroll off
  // under the composer while Claude is still writing it.
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [active?.blocks.length]);

  // Context usage only moves when a turn finishes, so read it on settle
  // instead of polling.
  useEffect(() => {
    if (!activeId || running) return;
    let cancelled = false;
    void api
      .contextUsage(activeId)
      .then((next) => !cancelled && setUsage(next))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [activeId, running, api, active?.blocks.length]);

  /**
   * A session nobody typed into wrote no transcript. Close it on the way out,
   * or the list fills with empty threads every time the planner switches away
   * from the one that was opened for them.
   */
  const discardIfUnused = useCallback(
    (sessionId: string | null) => {
      if (!sessionId) return;
      const view = sessions[sessionId];
      if (!view || !view.live || view.blocks.length > 0) return;
      void api.closeSession(sessionId).catch(() => undefined);
    },
    [api, sessions],
  );

  const openSession = async (summary: SessionSummary) => {
    if (summary.sessionId !== activeId) discardIfUnused(activeId);
    ensureSession(summary.sessionId);
    setActiveId(summary.sessionId);
    if (summary.live) markLive(summary.sessionId);
    try {
      hydrate(summary.sessionId, await api.history(summary.sessionId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const newSession = async () => {
    discardIfUnused(activeId);
    try {
      const { sessionId } = await api.createSession();
      ensureSession(sessionId);
      markLive(sessionId);
      setActiveId(sessionId);
      void refreshSessions();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  /** Permanently delete a stored planning thread. Confirms first unless turned off. */
  const deleteSession = async (session: SessionSummary) => {
    if (
      confirmBeforeDelete &&
      !window.confirm(`"${session.title}" 기획을 삭제할까요? 대화 기록이 영구히 사라집니다.`)
    )
      return;
    if (activeId === session.sessionId) setActiveId(null);
    try {
      await api.deleteSession(session.sessionId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    void refreshSessions();
  };

  const submit = async (text: string, attachments: Attachment[]) => {
    if (!root) return;
    try {
      let target = activeId;
      if (!target) {
        target = (await api.createSession()).sessionId;
      } else if (active && !active.live) {
        // A stored planning thread the planner picked from the list: continue
        // it in place. Forking is a developer's concern, not theirs.
        target = (await api.createSession(target)).sessionId;
      }
      ensureSession(target);
      markLive(target);
      setActiveId(target);

      await api.send(
        target,
        text,
        attachments
          .filter((a) => a.kind === "image")
          .map(({ mediaType, data }) => ({ mediaType, data })),
        attachments
          .filter((a) => a.kind === "document")
          .map(({ name, mediaType, data }) => ({ name, mediaType, data })),
      );
      void refreshSessions();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const errorKind = classifyError(repo?.detail ?? null);
  // Only a named preview death takes over the preview column; anything else
  // (a failed clone or pull, say) is answered by the retry panel, because the
  // preview may still be alive and worth looking at.
  const previewStopped = phase === "error" && errorKind === "preview";
  const showProgress = !repo || (phase !== "ready" && !previewStopped);
  const visiblePending = pending.filter((request) => request.sessionId === activeId);
  // The daemon knows why it cannot work — no CLI, not signed in, no pnpm — and
  // the planner cannot read a terminal to find out.
  const warnings = status?.warnings ?? [];

  return (
    <div className="planner">
      <header className="planner__header">
        <span className="brand-name">agent-hub</span>
        <span className="planner__spacer" />
        <span className="hint">
          데몬: {connection === "open" ? "연결됨" : connection}
          {repo?.url ? ` · ${repo.url}` : ""}
        </span>
        <button
          type="button"
          className="ghost"
          aria-label="설정"
          title="설정"
          onClick={onOpenSettings}
        >
          <GearIcon />
        </button>
      </header>

      {warnings.length > 0 && (
        <div className="planner__warnings">
          {warnings.map((warning) => (
            <div key={warning} className="notice notice--warn">
              <span className="notice__text">{warning}</span>
            </div>
          ))}
        </div>
      )}

      {showProgress ? (
        <div className="planner__body planner__body--single">
          <ProgressPanel
            phase={phase ?? "missing"}
            detail={repo?.detail ?? null}
            errorKind={errorKind}
            onRetry={sync}
            onOpenSettings={onOpenSettings}
          />
        </div>
      ) : (
        <div className="planner__body">
          <aside className="planner__sessions">
            <div className="sidebar__heading">
              <span className="sidebar__heading-label">기획 세션</span>
              <button type="button" className="ghost" onClick={() => void newSession()}>
                + 새 기획
              </button>
            </div>
            {sessionList.length === 0 && <p className="hint">첫 기획을 시작해 주세요.</p>}
            {sessionList.map((session) => (
              <div key={session.sessionId} className="row-wrap">
                <button
                  type="button"
                  data-session-id={session.sessionId}
                  className={session.sessionId === activeId ? "row row--active" : "row"}
                  onClick={() => void openSession(session)}
                >
                  <span className="row__title">{session.title}</span>
                  <span className="row__meta">
                    {session.live && <span className="dot dot--live" />}
                    {timeAgo(session.lastModified)}
                  </span>
                </button>
                <button
                  type="button"
                  className="row-delete"
                  aria-label={`${session.title} 삭제`}
                  title="기획 삭제 (대화 기록이 영구히 사라집니다)"
                  onClick={(e) => {
                    e.stopPropagation();
                    void deleteSession(session);
                  }}
                >
                  <CloseIcon size={10} />
                </button>
              </div>
            ))}
          </aside>

          <main className="planner__chat">
            <section className="scroll">
              {error && (
                <div className="notice notice--error">
                  <span className="notice__text">{error}</span>
                  <button
                    type="button"
                    className="notice__close"
                    aria-label="오류 닫기"
                    onClick={() => setError(null)}
                  >
                    ×
                  </button>
                </div>
              )}
              <Transcript blocks={active?.blocks ?? []} />
              {visiblePending.map((request) =>
                request.kind === "permission" ? (
                  <PermissionCard
                    key={request.requestId}
                    request={request}
                    onRespond={(decision, message) => {
                      void api.respondPermission(request.requestId, decision, message);
                      resolvePending(request.requestId);
                    }}
                  />
                ) : (
                  <QuestionCard
                    key={request.requestId}
                    request={request}
                    onRespond={(answers) => {
                      void api.respondQuestion(request.requestId, answers);
                      resolvePending(request.requestId);
                    }}
                  />
                ),
              )}
              <div ref={bottom} />
            </section>

            <Composer
              disabled={!root}
              placeholder="기획서를 첨부하고 만들고 싶은 화면을 말해 주세요"
              usage={usage}
              running={Boolean(running)}
              sendKey={sendKey}
              onSend={(text, attachments) => void submit(text, attachments)}
              onInterrupt={() => activeId && void api.interrupt(activeId)}
              onFindFiles={(query) => api.findFiles(query)}
            />
          </main>

          <section className="planner__preview">
            <Preview
              url={repo?.previewUrl ?? null}
              stopped={previewStopped}
              onRestart={sync}
            />
          </section>
        </div>
      )}
    </div>
  );
}
