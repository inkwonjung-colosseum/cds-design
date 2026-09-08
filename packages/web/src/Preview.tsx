/**
 * The preview pane: the connected repo's own preview server, framed as-is.
 * What renders inside is the repo's business — the tool only waits for the
 * daemon to report a serving URL.
 */
export function Preview({
  url,
  stopped,
  onRestart,
}: {
  url: string | null;
  /** The preview server died after being ready; the iframe would show nothing. */
  stopped: boolean;
  onRestart: () => void;
}) {
  if (stopped) {
    return (
      <div className="preview">
        <div className="preview__blank">
          <h2>미리보기 서버 중단</h2>
          <p className="hint">화면을 그리는 서버가 멈췄습니다. 대화 내용은 그대로입니다.</p>
          <button type="button" className="primary" onClick={onRestart}>
            다시 시작
          </button>
        </div>
      </div>
    );
  }

  if (!url) {
    return (
      <div className="preview">
        <div className="preview__blank">
          <p className="hint">미리보기 주소를 기다리는 중입니다.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="preview">
      <div className="preview__toolbar">
        <span className="hint preview__origin">{url}</span>
        <a className="preview__link" href={url} target="_blank" rel="noreferrer">
          새 창
        </a>
      </div>
      <iframe className="preview__frame" title="미리보기" src={url} />
    </div>
  );
}
