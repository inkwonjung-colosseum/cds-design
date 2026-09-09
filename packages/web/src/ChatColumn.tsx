import { useEffect, useRef } from "react";
import type { Workspace } from "@drafthouse/protocol";
import type { Daemon } from "./daemon-client";
import type { Sessions } from "./useSessions";
import { PermissionCard, QuestionCard, Transcript } from "./components";
import { Composer } from "./Composer";
import type { DocQuote } from "./DocEditor";
import type { SendKey } from "./settings";

/**
 * The middle column both workspaces share: one transcript, the cards that
 * interrupt it, and the composer under it. Everything workspace-specific
 * arrives as props — the column itself never asks which half it is in.
 */
export function ChatColumn({
  daemon,
  sessions,
  sendKey,
  workspace,
  placeholder,
  disabled,
  quote,
  onDismissQuote,
  brief,
  onDismissBrief,
  draft,
  onDraftConsumed,
  emptyHint,
}: {
  daemon: Daemon;
  sessions: Sessions;
  sendKey: SendKey;
  /** Which file set @-mentions draw from. */
  workspace: Workspace;
  placeholder: string;
  disabled: boolean;
  /** A passage dragged out of the planning editor, shown as a chip. */
  quote?: DocQuote | null;
  onDismissQuote?: () => void;
  /**
   * The 기획서 a 화면 thread was opened on, shown as a chip. The mirror path
   * it carries is attached to the turn on send, never typed (PLAN D9).
   */
  brief?: { title: string; path: string } | null;
  onDismissBrief?: () => void;
  /** Prefilled first turn from the 기획→디자인 handoff; never sent for them. */
  draft?: { text: string; nonce: number } | null;
  onDraftConsumed?: () => void;
  /**
   * What an empty transcript says instead of the default invitation — used
   * when the workspace is not ready and the chat cannot be started yet.
   */
  emptyHint?: string;
}) {
  const { api, pending, resolvePending } = daemon;
  const bottom = useRef<HTMLDivElement>(null);
  const { active, activeId, error, setError } = sessions;
  const visiblePending = pending.filter((request) => request.sessionId === activeId);

  // Follow the conversation as it grows, so a long answer does not scroll off
  // under the composer while Claude is still writing it.
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [active?.blocks.length]);

  return (
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
        {emptyHint && (active?.blocks.length ?? 0) === 0 ? (
          <p className="empty">{emptyHint}</p>
        ) : (
          <Transcript blocks={active?.blocks ?? []} live={sessions.running} />
        )}
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
        disabled={disabled}
        placeholder={placeholder}
        usage={sessions.usage}
        plan={daemon.status?.planUsage ?? null}
        selector={sessions.selector}
        commands={sessions.commands}
        onSetModel={(model) => void sessions.setModel(model)}
        onSetEffort={(effort) => void sessions.setEffort(effort)}
        onSetPermissionMode={(mode) => void sessions.setPermissionMode(mode)}
        running={sessions.running}
        sendKey={sendKey}
        quote={quote}
        onDismissQuote={onDismissQuote}
        brief={brief}
        onDismissBrief={onDismissBrief}
        initialText={draft}
        onInitialTextConsumed={onDraftConsumed}
        onSend={(text, attachments) => {
          void sessions.submit(text, attachments);
          onDismissQuote?.();
        }}
        onInterrupt={() => activeId && void api.interrupt(activeId)}
        onFindFiles={(query) => api.findFiles(workspace, query)}
      />
    </main>
  );
}
