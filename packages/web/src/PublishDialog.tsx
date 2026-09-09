import { useEffect, useState } from "react";
import type { ConfluenceReview } from "@drafthouse/protocol";
import { CloseIcon } from "./icons";

/**
 * 게시's last step is a write to Confluence, so the button asks first and
 * shows what would go up: every pending page, its version bump, and the line
 * diff of its body. A push the planner did not understand is the one thing
 * this dialog exists to prevent — the review costs a local read, the push
 * costs a remote version.
 */
export function PublishDialog({
  review,
  spaceTitle,
  error,
  pushing,
  onConfirm,
  onClose,
}: {
  /** Null while the daemon is still computing the review. */
  review: ConfluenceReview | null;
  spaceTitle: string | null;
  error: string | null;
  pushing: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const pages = review?.pages ?? [];
  // A conflicted page would stop the push mid-way anyway: refuse now, in
  // words, instead of after a partial upload.
  const conflicted = pages.filter((page) => page.conflict);
  const [openDiff, setOpenDiff] = useState<string | null>(null);

  // Escape is how every other dismissible surface in the app closes.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pushing) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [pushing, onClose]);

  return (
    <div className="modal">
      <div className="modal__panel modal__panel--publish" role="dialog" aria-modal="true" aria-label="기획서 게시 확인">
        <header className="modal__head">
          <h2 className="modal__title">기획서 게시</h2>
          <button type="button" className="ghost" aria-label="게시 닫기" disabled={pushing} onClick={onClose}>
            <CloseIcon />
          </button>
        </header>
        <div className="modal__body">
          <p className="hint">
            아래 내용이 Confluence에 올라갑니다
            {spaceTitle ? ` — 스페이스 "${spaceTitle}"` : ""} · 페이지 {pages.length}개.
          </p>

          {!review && !error && <p className="hint">무엇이 바뀌는지 확인하는 중…</p>}
          {pages.length === 0 && review && <p className="hint">보낼 변경이 없습니다.</p>}

          <ul className="publish__list">
            {pages.map((page) => (
              <li key={page.pageId} className="publish__page">
                <div className="publish__page-head">
                  {page.isNew ? (
                    <span className="pagetree__flag pagetree__flag--new">신규</span>
                  ) : (
                    <span className="pagetree__flag">수정됨</span>
                  )}
                  <span className="publish__title">{page.title}</span>
                  <span className="publish__ver">
                    {page.isNew ? "새 페이지로 만들어요" : `v${page.version} → v${page.nextVersion}`}
                  </span>
                  <span className="publish__delta">{`+${page.added}`}</span>
                  <span className="publish__delta publish__delta--minus">{`−${page.removed}`}</span>
                  <button
                    type="button"
                    className="ghost"
                    aria-expanded={openDiff === page.pageId}
                    onClick={() => setOpenDiff(openDiff === page.pageId ? null : page.pageId)}
                  >
                    {openDiff === page.pageId ? "접기" : "변화 보기"}
                  </button>
                </div>
                {page.conflict && (
                  <p className="publish__conflict">충돌 — 게시 전에 문서에서 어느 쪽을 남길지 골라 주세요.</p>
                )}
                {openDiff === page.pageId && <pre className="publish__diff">{page.diff || "(본문 변화 없음)"}</pre>}
              </li>
            ))}
          </ul>

          {conflicted.length > 0 && (
            <p className="notice notice--warn">
              <span className="notice__text">
                충돌 {conflicted.length}건이 있어 지금은 게시할 수 없습니다 — 먼저 문서에서 해결해 주세요.
              </span>
            </p>
          )}
          {error && (
            <p className="notice notice--error">
              <span className="notice__text">{error}</span>
            </p>
          )}

          <div className="settings__row">
            <button
              type="button"
              className="primary"
              disabled={pushing || !review || pages.length === 0 || conflicted.length > 0}
              title={pages.length === 0 ? "보낼 변경이 없습니다" : "Confluence에 올립니다"}
              onClick={onConfirm}
            >
              {pushing ? "올리는 중…" : `게시 (${pages.length})`}
            </button>
            <button type="button" className="ghost" disabled={pushing} onClick={onClose}>
              그만두기
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
