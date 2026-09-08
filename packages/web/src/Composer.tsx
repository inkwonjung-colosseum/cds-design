import { useEffect, useRef, useState } from "react";
import type { ContextUsage } from "@agent-hub/protocol";
import type { SendKey } from "./settings";
import { PaperclipIcon, SendIcon, StopIcon } from "./icons";

export interface Attachment {
  /** Images ride inline with the turn; documents are saved to `specs/` by the daemon. */
  kind: "image" | "document";
  name: string;
  mediaType: string;
  /** base64, without the data-url prefix. */
  data: string;
  size: number;
}

/** What a planner may attach as a document. Claude's Read tool handles all three. */
const DOCUMENT_TYPES: Record<string, string> = {
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".pdf": "application/pdf",
};

function documentType(name: string): string | null {
  const dot = name.lastIndexOf(".");
  // Browsers leave `type` empty for .md, so the extension decides.
  return dot === -1 ? null : (DOCUMENT_TYPES[name.slice(dot).toLowerCase()] ?? null);
}

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * How much of the conversation Claude can still hold. A planning thread that
 * runs long starts losing its own beginning, and the honest fix is to start a
 * new 기획 — so the number is shown before that happens, not after.
 */
function ContextRing({ usage }: { usage: ContextUsage }) {
  const pct = Math.max(0, Math.min(100, usage.percentage));
  const radius = 8;
  const circumference = 2 * Math.PI * radius;
  const tone = pct >= 85 ? "var(--danger)" : pct >= 60 ? "var(--warn)" : "var(--accent)";
  const hint =
    pct >= 85
      ? " — 곧 앞부분을 잊습니다. 새 기획으로 나누는 편이 좋습니다."
      : pct >= 60
        ? " — 대화가 길어지고 있습니다."
        : "";

  return (
    <span
      className="ring"
      title={`대화 길이 ${pct}% 사용${hint}`}
      aria-label={`대화 길이 ${pct} 퍼센트 사용`}
    >
      <svg width="20" height="20" viewBox="0 0 20 20">
        <circle cx="10" cy="10" r={radius} fill="none" stroke="var(--line)" strokeWidth="2.5" />
        <circle
          cx="10"
          cy="10"
          r={radius}
          fill="none"
          stroke={tone}
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - pct / 100)}
          transform="rotate(-90 10 10)"
        />
      </svg>
      <span className="ring__text">{pct}%</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Autocomplete for @files
// ---------------------------------------------------------------------------

interface Suggestion {
  insert: string;
  label: string;
}

/**
 * Work out whether the caret sits in an @mention. Returns the token being typed
 * so the caller can look up matches, plus the span to replace when one is
 * chosen. Attached documents land in `specs/`, so `@specs/…` is how a planner
 * points Claude back at one they sent earlier.
 */
function activeMention(text: string, caret: number): { query: string; from: number } | null {
  const before = text.slice(0, caret);
  const at = /(^|\s)@(\S*)$/.exec(before);
  if (!at) return null;
  const query = at[2] ?? "";
  return { query, from: caret - query.length - 1 };
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

export function Composer({
  disabled,
  placeholder,
  usage,
  running,
  sendKey,
  onSend,
  onInterrupt,
  onFindFiles,
}: {
  disabled: boolean;
  placeholder: string;
  usage: ContextUsage | null;
  running: boolean;
  /** Which keypress sends; the other one inserts a newline. */
  sendKey: SendKey;
  onSend: (text: string, attachments: Attachment[]) => void;
  onInterrupt: () => void;
  onFindFiles: (query: string) => Promise<string[]>;
}) {
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [highlight, setHighlight] = useState(0);
  const [tokenSpan, setTokenSpan] = useState<{ from: number; to: number } | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const filePicker = useRef<HTMLInputElement>(null);
  const [rejected, setRejected] = useState<string | null>(null);

  // Grow the textarea with its content, up to the CSS max-height.
  useEffect(() => {
    const element = area.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 220)}px`;
  }, [draft]);

  // Recompute suggestions whenever the caret lands in an @ token.
  useEffect(() => {
    const element = area.current;
    if (!element) return;
    const caret = element.selectionStart ?? draft.length;
    const token = activeMention(draft, caret);
    if (!token) {
      setSuggestions([]);
      setTokenSpan(null);
      return;
    }

    setTokenSpan({ from: token.from, to: caret });
    setHighlight(0);

    let cancelled = false;
    void onFindFiles(token.query).then((files) => {
      if (cancelled) return;
      setSuggestions(files.slice(0, 8).map((f) => ({ insert: `@${f} `, label: f })));
    });
    return () => {
      cancelled = true;
    };
  }, [draft, onFindFiles]);

  const applySuggestion = (suggestion: Suggestion) => {
    if (!tokenSpan) return;
    const next = draft.slice(0, tokenSpan.from) + suggestion.insert + draft.slice(tokenSpan.to);
    setDraft(next);
    setSuggestions([]);
    setTokenSpan(null);
    requestAnimationFrame(() => {
      const element = area.current;
      if (!element) return;
      const caret = tokenSpan.from + suggestion.insert.length;
      element.focus();
      element.setSelectionRange(caret, caret);
    });
  };

  const readAttachments = async (files: FileList | File[]) => {
    const accepted: Array<{ file: File; kind: Attachment["kind"]; mediaType: string }> = [];
    const refused: string[] = [];
    for (const file of [...files]) {
      const document = documentType(file.name);
      if (file.type.startsWith("image/")) {
        accepted.push({ file, kind: "image", mediaType: file.type });
      } else if (document) {
        accepted.push({ file, kind: "document", mediaType: document });
      } else {
        refused.push(file.name);
      }
    }
    setRejected(
      refused.length > 0
        ? `${refused.join(", ")} — 첨부할 수 없는 형식입니다. PDF로 내보내서 다시 첨부해 주세요.`
        : null,
    );
    if (accepted.length === 0) return;
    const read = await Promise.all(
      accepted.map(
        ({ file, kind, mediaType }) =>
          new Promise<Attachment>((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(new Error(`could not read ${file.name}`));
            reader.onload = () => {
              const result = String(reader.result);
              resolve({
                kind,
                name: file.name || "pasted image",
                mediaType,
                data: result.slice(result.indexOf(",") + 1),
                size: file.size,
              });
            };
            reader.readAsDataURL(file);
          }),
      ),
    );
    setAttachments((prev) => [...prev, ...read]);
  };

  const submit = () => {
    const text = draft.trim();
    if (!text && attachments.length === 0) return;
    onSend(text, attachments);
    setDraft("");
    setAttachments([]);
    setSuggestions([]);
    setRejected(null);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggestions.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setHighlight((h) => (h + 1) % suggestions.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setHighlight((h) => (h - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
        event.preventDefault();
        const picked = suggestions[highlight];
        if (picked) applySuggestion(picked);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setSuggestions([]);
        return;
      }
    }
    if (event.key !== "Enter") return;
    // With "enter", a bare Enter sends and Shift+Enter is a newline. With
    // "modEnter" it is the other way round, and the modifier is what sends.
    const sends = sendKey === "enter" ? !event.shiftKey : event.metaKey || event.ctrlKey;
    if (!sends) return;
    event.preventDefault();
    submit();
  };

  return (
    <footer
      className="composer"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        void readAttachments(e.dataTransfer.files);
      }}
    >
      {suggestions.length > 0 && (
        <div className="autocomplete" role="listbox">
          {suggestions.map((suggestion, index) => (
            <button
              key={suggestion.label}
              type="button"
              role="option"
              aria-selected={index === highlight}
              className={index === highlight ? "autocomplete__row autocomplete__row--on" : "autocomplete__row"}
              onMouseEnter={() => setHighlight(index)}
              onClick={() => applySuggestion(suggestion)}
            >
              <span className="autocomplete__label">{suggestion.label}</span>
            </button>
          ))}
        </div>
      )}

      {rejected && (
        <div className="notice notice--warn">
          <span className="notice__text">{rejected}</span>
          <button
            type="button"
            className="notice__close"
            aria-label="첨부 안내 닫기"
            onClick={() => setRejected(null)}
          >
            ×
          </button>
        </div>
      )}

      {attachments.length > 0 && (
        <div className="chips">
          {attachments.map((attachment, index) => (
            <span key={`${attachment.name}-${index}`} className="chip">
              {attachment.kind === "image" ? (
                <img
                  className="chip__thumb"
                  src={`data:${attachment.mediaType};base64,${attachment.data}`}
                  alt=""
                />
              ) : (
                <span className="chip__doc">문서</span>
              )}
              {attachment.name}
              {attachment.kind === "document" && (
                <span className="chip__size">{fileSize(attachment.size)}</span>
              )}
              <button
                type="button"
                className="ghost"
                aria-label={`${attachment.name} 첨부 취소`}
                onClick={() => setAttachments((prev) => prev.filter((_, i) => i !== index))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <textarea
        ref={area}
        value={draft}
        placeholder={placeholder}
        disabled={disabled}
        rows={1}
        onChange={(e) => setDraft(e.target.value)}
        onPaste={(e) => {
          const files = [...e.clipboardData.files];
          if (files.length) void readAttachments(files);
        }}
        onKeyDown={onKeyDown}
      />

      <div className="toolbar">
        <input
          ref={filePicker}
          type="file"
          accept="image/*,.md,.txt,.pdf"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) void readAttachments(e.target.files);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          className="toolbar__icon"
          title="기획서·이미지 첨부"
          aria-label="기획서 첨부"
          disabled={disabled}
          onClick={() => filePicker.current?.click()}
        >
          <PaperclipIcon />
        </button>

        <span className="toolbar__spacer" />

        {usage && <ContextRing usage={usage} />}

        {running ? (
          <button type="button" className="toolbar__stop" onClick={onInterrupt}>
            <StopIcon />
            중지
          </button>
        ) : (
          <button
            type="button"
            className="primary"
            disabled={disabled || (!draft.trim() && attachments.length === 0)}
            onClick={submit}
            title={sendKey === "enter" ? "보내기 · Enter" : "보내기 · ⌘/Ctrl+Enter"}
          >
            <SendIcon />
            보내기
          </button>
        )}
      </div>
    </footer>
  );
}
