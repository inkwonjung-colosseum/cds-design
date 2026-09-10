import type { ConfluenceConflict } from "@cds-design/protocol";
import { CloseIcon } from "./icons";

/**
 * The three-way conflict chooser (DESIGN §4.2: 내 것으로 덮기 / 원격 받기 /
 * 직접 보기). 직접 보기 shows mine and theirs side by side; the file can be
 * edited in the 원문 toggle, and 내 것으로 덮기 then settles it.
 */
export function ConflictModal({
  conflict,
  manual,
  onResolve,
  onManual,
}: {
  conflict: ConfluenceConflict;
  /** Direct view: mine and theirs shown, edit-then-overwrite enabled. */
  manual?: boolean;
  onResolve: (choice: "mine" | "theirs") => void;
  onManual: () => void;
}) {
  return (
    <div className="modal">
      <div className="modal__panel modal__panel--conflict" role="dialog" aria-modal="true" aria-label="충돌 해결">
        <header className="modal__head">
          <h2 className="modal__title">충돌: {conflict.title}</h2>
          <button type="button" className="ghost" aria-label="충돌 닫기" onClick={onManual}>
            <CloseIcon />
          </button>
        </header>
        <div className="modal__body">
          <p className="hint">
            이 페이지는 내가 고친 뒤 원격에서도 바뀌었습니다 (내 버전 v{conflict.mine.version} · 원격 v
            {conflict.theirs.version} · 마지막 동기화 v{conflict.base?.version ?? "?"}).
          </p>

          {manual ? (
            <div className="conflict__sides">
              <section className="conflict__side">
                <h3>내 것 (편집 가능)</h3>
                <pre>
                  <code>{stripFrontmatter(conflict.mine.markdown)}</code>
                </pre>
              </section>
              <section className="conflict__side">
                <h3>원격</h3>
                <pre>
                  <code>{stripFrontmatter(conflict.theirs.markdown)}</code>
                </pre>
              </section>
            </div>
          ) : null}

          <div className="settings__row">
            <button type="button" className="primary" onClick={() => onResolve("mine")}>
              내 것으로 덮기
            </button>
            <button type="button" onClick={() => onResolve("theirs")}>
              원격 받기
            </button>
            <button type="button" className="ghost" onClick={onManual}>
              {manual ? "요약으로" : "직접 보기"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function stripFrontmatter(markdown: string): string {
  const lines = markdown.split("\n");
  if (lines[0] !== "---") return markdown;
  const end = lines.indexOf("---", 1);
  return end < 0 ? markdown : lines.slice(end + 1).join("\n").replace(/^\n+/, "");
}
