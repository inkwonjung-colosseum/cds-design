import { useEffect, useRef, useState } from "react";
import type { DaemonStatus } from "@agent-hub/protocol";
import type { Daemon } from "./daemon-client";
import { CloseIcon } from "./icons";
import { THEMES, type SendKey, type Settings, type ThemeChoice } from "./settings";

const THEME_LABEL: Record<ThemeChoice, string> = {
  system: "시스템 설정을 따름",
  dark: "어둡게",
  light: "밝게",
};

const SEND_LABEL: Record<SendKey, string> = {
  enter: "Enter로 보내기, Shift+Enter는 줄바꿈",
  modEnter: "⌘/Ctrl+Enter로 보내기, Enter는 줄바꿈",
};

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function Field({
  label,
  hint,
  wide,
  children,
}: {
  label: string;
  hint?: string;
  /** Put the control on its own line, for anything wider than a picker. */
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className={wide ? "setting setting--wide" : "setting"}>
      <span className="setting__text">
        <span className="setting__label">{label}</span>
        {hint && <span className="setting__hint">{hint}</span>}
      </span>
      <span className="setting__control">{children}</span>
    </label>
  );
}

function Choice<T extends string>({
  label,
  hint,
  value,
  options,
  onChange,
}: {
  label: string;
  hint?: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <Field label={label} {...(hint ? { hint } : {})}>
      <select value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

function Switch({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <Field label={label} {...(hint ? { hint } : {})}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </Field>
  );
}

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

export function SettingsDialog({
  settings,
  onChange,
  daemonUrl,
  status,
  connection,
  daemon,
  onReconnect,
  onForgetUrl,
  onClose,
}: {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  daemonUrl: string | null;
  status: DaemonStatus | null;
  connection: string;
  /** The connected repo's url/PAT live daemon-side; the dialog only edits them. */
  daemon: Daemon;
  onReconnect: (url: string) => void;
  onForgetUrl: () => void;
  onClose: () => void;
}) {
  const [url, setUrl] = useState(daemonUrl ?? "");
  const panel = useRef<HTMLDivElement>(null);

  // The repo url arrives asynchronously (repo.status); adopt it until the
  // planner edits the field, so reopening the dialog shows what is stored.
  const [repoUrlDraft, setRepoUrlDraft] = useState<string | null>(null);
  const [patDraft, setPatDraft] = useState("");
  const [repoError, setRepoError] = useState<string | null>(null);
  const [savingRepo, setSavingRepo] = useState(false);
  const connected = daemon.connection === "open";
  const repoUrl = repoUrlDraft ?? daemon.repo?.url ?? "";

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [onClose]);

  // Move focus into the dialog so Escape and Tab act on it rather than on the
  // page behind it.
  useEffect(() => {
    panel.current?.focus();
  }, []);

  const urlChanged = url.trim().length > 0 && url.trim() !== (daemonUrl ?? "");

  /** The PAT is write-only: it goes to the daemon and never comes back. */
  const saveRepo = async () => {
    setSavingRepo(true);
    setRepoError(null);
    try {
      await daemon.api.repoUpdate(repoUrl.trim() || null, patDraft.trim() || undefined);
      setPatDraft("");
    } catch (e) {
      setRepoError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingRepo(false);
    }
  };

  return (
    <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal__panel"
        role="dialog"
        aria-modal="true"
        aria-label="설정"
        tabIndex={-1}
        ref={panel}
      >
        <header className="modal__head">
          <h2 className="modal__title">설정</h2>
          <button type="button" className="ghost" aria-label="설정 닫기" onClick={onClose}>
            <CloseIcon />
          </button>
        </header>

        <div className="modal__body">
          <section className="settings__group">
            <h3 className="settings__groupTitle">화면</h3>
            <Choice<ThemeChoice>
              label="테마"
              value={settings.theme}
              options={THEMES.map((theme) => ({ value: theme, label: THEME_LABEL[theme] }))}
              onChange={(theme) => onChange({ theme })}
            />
          </section>

          <section className="settings__group">
            <h3 className="settings__groupTitle">동작</h3>
            <Choice<SendKey>
              label="보내기 키"
              value={settings.sendKey}
              options={(["enter", "modEnter"] as SendKey[]).map((key) => ({
                value: key,
                label: SEND_LABEL[key],
              }))}
              onChange={(sendKey) => onChange({ sendKey })}
            />
            <Switch
              label="기획을 삭제하기 전에 확인"
              hint="삭제하면 대화 기록이 이 컴퓨터에서 영구히 사라집니다"
              checked={settings.confirmBeforeDelete}
              onChange={(confirmBeforeDelete) => onChange({ confirmBeforeDelete })}
            />
          </section>

          <section className="settings__group">
            <h3 className="settings__groupTitle">연결 레포</h3>
            <Field
              wide
              label="레포 주소"
              hint={
                connected
                  ? daemon.repo?.patConfigured
                    ? "개인 액세스 토큰 설정됨"
                    : "git clone 주소(https://…). 비공개 레포면 토큰도 넣어 주세요"
                  : "데몬에 연결된 뒤 저장할 수 있습니다"
              }
            >
              <span className="settings__url">
                <input
                  value={repoUrl}
                  spellCheck={false}
                  placeholder="https://github.com/<조직>/<레포>.git"
                  aria-label="연결 레포 주소"
                  disabled={!connected}
                  onChange={(e) => setRepoUrlDraft(e.target.value)}
                />
                <button
                  type="button"
                  className="primary"
                  disabled={!connected || savingRepo}
                  onClick={() => void saveRepo()}
                >
                  {savingRepo ? "저장 중…" : "저장"}
                </button>
              </span>
            </Field>
            <Field
              wide
              label="개인 액세스 토큰(PAT)"
              hint={
                daemon.repo?.patConfigured
                  ? "설정됨 — 다시 입력하면 교체됩니다. 값은 데몬에만 저장됩니다"
                  : "값은 데몬에만 저장되고 다시 보여지지 않습니다"
              }
            >
              <input
                type="password"
                value={patDraft}
                placeholder={daemon.repo?.patConfigured ? "••••••••" : "ghp_…"}
                aria-label="연결 레포 개인 액세스 토큰"
                disabled={!connected}
                onChange={(e) => setPatDraft(e.target.value)}
              />
            </Field>
            {repoError && (
              <div className="notice notice--error">
                <span className="notice__text">{repoError}</span>
              </div>
            )}
          </section>

          <section className="settings__group">
            <h3 className="settings__groupTitle">데몬</h3>
            <Field
              wide
              label="접속 주소"
              hint={`연결 상태: ${connection}. 데몬을 켜면 이 주소를 출력합니다.`}
            >
              <span className="settings__url">
                <input
                  value={url}
                  spellCheck={false}
                  placeholder="ws://127.0.0.1:7823?token=…"
                  aria-label="데몬 접속 주소"
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && urlChanged && onReconnect(url.trim())}
                />
                <button
                  type="button"
                  className="primary"
                  disabled={!urlChanged}
                  onClick={() => onReconnect(url.trim())}
                >
                  다시 연결
                </button>
              </span>
            </Field>

            {status && (
              <dl className="settings__facts">
                <div>
                  <dt>운영체제</dt>
                  <dd>{status.platform}</dd>
                </div>
                <div>
                  <dt>Claude Code</dt>
                  <dd>{status.claudeVersion ?? "찾지 못함"}</dd>
                </div>
                <div>
                  <dt>로그인</dt>
                  <dd>
                    {status.loggedIn
                      ? [status.email, status.subscriptionType ?? status.authMethod]
                          .filter(Boolean)
                          .join(" · ") || "로그인됨"
                      : "로그인 안 됨"}
                  </dd>
                </div>
                <div>
                  <dt>pnpm</dt>
                  <dd>{status.pnpmAvailable ? "사용 가능" : "없음"}</dd>
                </div>
                <div>
                  <dt>실행 중인 기획</dt>
                  <dd>{status.liveSessions}</dd>
                </div>
                <div>
                  <dt>프로토콜</dt>
                  <dd>v{status.protocolVersion}</dd>
                </div>
              </dl>
            )}

            <div className="settings__row">
              <button
                type="button"
                className="danger"
                onClick={() => {
                  if (
                    !window.confirm(
                      "저장된 접속 주소를 지울까요? 이 컴퓨터의 기획은 그대로 남지만, 데몬이 출력한 주소를 다시 붙여 넣어야 합니다.",
                    )
                  )
                    return;
                  onForgetUrl();
                }}
              >
                접속 주소 지우기
              </button>
              <span className="setting__hint">연결 화면으로 돌아갑니다. 기획은 삭제되지 않습니다.</span>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
