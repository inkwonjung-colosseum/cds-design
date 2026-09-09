/** Timestamps read as "얼마 전"; an exact date only helps once it is old. */
export function timeAgo(ts: number): string {
  const seconds = Math.max(0, (Date.now() - ts) / 1000);
  if (seconds < 60) return "방금";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}분 전`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}시간 전`;
  if (seconds < 7 * 86400) return `${Math.floor(seconds / 86400)}일 전`;
  return new Date(ts).toLocaleDateString();
}

/**
 * Screen states, in the planner's language (PLAN D13).
 *
 * The four names below are the ones `CLAUDE.md` asks a connected repo to use,
 * so they cover what the preview will normally offer. A repo that declares
 * something else keeps its own word — inventing a Korean gloss for a state we
 * have never seen would put a label on the chip that the 기획서 does not use.
 */
const STATE_LABEL: Record<string, string> = {
  default: "기본",
  empty: "비어 있음",
  loading: "불러오는 중",
  error: "오류",
};

export function stateLabel(state: string): string {
  return STATE_LABEL[state] ?? state;
}
