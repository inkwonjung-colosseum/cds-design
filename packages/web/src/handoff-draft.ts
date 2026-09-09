import type { DrafthouseScreen } from "@drafthouse/protocol";

/**
 * What the 넘기기 dialog opens on (PLAN D5).
 *
 * The daemon owns the fallback — it is the side that can list a project's
 * 기획서 pages and link them — so this contributes only what the browser
 * knows: which screens the running app declared, and the states each one
 * implements. A blank field never crosses the wire, which is what lets the
 * daemon's own proposal win when the repo reports nothing.
 *
 * `pageId: <id>` is load-bearing spelling, not decoration: the daemon scans
 * the pull request body for that token to badge those pages ✓ 넘김 (§2.4).
 * A screen whose 기획서 is not one of the project's pages contributes no line
 * at all rather than a line with a hole in it.
 *
 * Deliberately absent: the preview URL. It is a loopback address on the
 * planner's own machine, and in a pull request a developer reads, a link that
 * looks openable and never is costs more than no link.
 */
export function handoffDraft(
  projectName: string,
  screens: DrafthouseScreen[],
  pageIdOf: (specPath: string) => string | null,
): { title: string; body: string } {
  return {
    // The project is usually already named for what it is ("재고 실사 화면");
    // appending 화면 unconditionally produced "재고 실사 화면 화면".
    title: projectName ? (projectName.endsWith("화면") ? projectName : `${projectName} 화면`) : "",
    body: bodyFor(screens, pageIdOf),
  };
}

function bodyFor(
  screens: DrafthouseScreen[],
  pageIdOf: (specPath: string) => string | null,
): string {
  const lines: string[] = [];
  for (const screen of screens) {
    const pageId = screen.spec ? pageIdOf(screen.spec) : null;
    if (!pageId) continue;
    // The states the repo DECLARED for this screen. This is the only
    // mechanical answer a developer gets to "how far did the mock go":
    // §2.4 refuses to badge 인터랙션 완료 because judging it means reading the
    // 기획서, so the list is handed over unjudged instead of summarised.
    const states = screen.states.length > 0 ? ` — 상태 ${screen.states.join(" · ")}` : "";
    lines.push(`- ${screen.title} \`${screen.route}\`${states} (pageId: ${pageId})`);
  }
  // The trailing blank line is deliberate: the planner types on top of this
  // proposal, and the daemon appends below it.
  return lines.length > 0 ? `넘기는 화면:\n${lines.join("\n")}\n\n` : "";
}
