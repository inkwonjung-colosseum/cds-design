import type { SessionSummary, Workspace } from "@drafthouse/protocol";
import { CloseIcon } from "./icons";
import type { Sessions } from "./useSessions";

/**
 * A 기획 thread and a 화면 thread of the same page sit side by side in one
 * strip, so every tab says which half it belongs to in words: colour alone
 * would not survive the light theme, a screenshot, or a planner in a hurry.
 */
const KIND: Record<Workspace, string> = { planning: "기획", design: "화면" };
const DELETE_TITLE: Record<Workspace, string> = {
  planning: "기획 삭제 (대화 기록이 영구히 사라집니다)",
  design: "화면 삭제 (대화 기록이 영구히 사라집니다)",
};

/**
 * A tab shows what the thread is about, not the whole first message: the
 * strip gets one line per thread, and a `@confluence/<경로> …` brief would
 * spend it on a machine path the planner never asked to read. The full text
 * stays one hover away in the button's title.
 */
function tabTitle(title: string): string {
  const withoutBrief = title.replace(/^@confluence\/\S+\s*/, "");
  const text = (withoutBrief || title).trim();
  return text.length > 28 ? `${text.slice(0, 28)}…` : text;
}

/**
 * The session strip above the transcript: every thread of the open 기획서
 * page, both halves of it, plus the two ways to start another one.
 *
 * Purely presentational — it holds no session state and does no confirming.
 * `onClose` lands in `Sessions.remove`, which already asks before deleting;
 * a second prompt here would make the planner answer twice.
 */
export function SessionTabs(props: {
  planning: Sessions;
  design: Sessions;
  active: { workspace: Workspace; sessionId: string } | null;
  onSelect: (workspace: Workspace, session: SessionSummary) => void;
  onCreate: (workspace: Workspace) => void;
  onClose: (workspace: Workspace, session: SessionSummary) => void;
  /** No page open: the strip explains that instead of offering tabs. */
  disabled?: boolean;
}) {
  const { planning, design, active, onSelect, onCreate, onClose, disabled = false } = props;

  // 기획 first, then 화면, each in the order its own list already carries
  // (newest first): the strip's order must not shuffle as threads stream.
  const tabs: Array<{ workspace: Workspace; session: SessionSummary }> = [
    ...planning.list.map((session) => ({ workspace: "planning" as Workspace, session })),
    ...design.list.map((session) => ({ workspace: "design" as Workspace, session })),
  ];

  return (
    <div className="sessiontabs">
      {/* Each tab is an ordinary focusable button, like the header's 작업 탭:
          Tab walks the strip, Enter/Space opens. No roving tabindex, so the
          two conventions in the app do not disagree. */}
      <div className="sessiontabs__strip" role="tablist" aria-label="세션 탭">
        {!disabled &&
          tabs.map(({ workspace, session }) => {
            const on = active?.workspace === workspace && active.sessionId === session.sessionId;
            return (
              <div
                key={`${workspace}:${session.sessionId}`}
                role="presentation"
                className="sessiontab-wrap"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={on}
                  data-session-id={session.sessionId}
                  className={on ? "sessiontab sessiontab--on" : "sessiontab"}
                  title={`${KIND[workspace]} · ${session.title}`}
                  onClick={() => onSelect(workspace, session)}
                >
                  <span className="sessiontab__kind">{KIND[workspace]}</span>
                  <span className="sessiontab__title">{tabTitle(session.title)}</span>
                  {session.live && <span className="dot dot--live" />}
                  {/* Finished while the planner was elsewhere. A live dot that
                      just disappears reads the same as a thread that never
                      ran, and the whole point of the strip is that a turn can
                      keep going while another tab is open. */}
                  {!session.live &&
                    (workspace === "planning" ? planning : design).finished.includes(
                      session.sessionId,
                    ) && <span className="dot dot--done" title="답이 왔습니다" />}
                </button>
                <button
                  type="button"
                  className="sessiontab__close"
                  aria-label={`${session.title} 삭제`}
                  title={DELETE_TITLE[workspace]}
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose(workspace, session);
                  }}
                >
                  <CloseIcon size={9} />
                </button>
              </div>
            );
          })}
        {disabled && <p className="hint">왼쪽에서 기획서를 골라 주세요.</p>}
        {!disabled && tabs.length === 0 && <p className="hint">이 기획서의 첫 대화를 시작해 주세요.</p>}
      </div>
      <span className="sessiontabs__spacer" />
      <button
        type="button"
        className="ghost"
        disabled={disabled}
        title={disabled ? "기획서를 먼저 골라 주세요" : "이 기획서에서 새 기획 대화 시작"}
        onClick={() => onCreate("planning")}
      >
        + 새 기획
      </button>
      <button
        type="button"
        className="ghost"
        disabled={disabled}
        title={disabled ? "기획서를 먼저 골라 주세요" : "이 기획서로 화면 만들기"}
        onClick={() => onCreate("design")}
      >
        + 화면 만들기
      </button>
    </div>
  );
}
