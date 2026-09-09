import { useEffect, useRef, useState } from "react";
import type {
  ContextUsage,
  EffortLevel,
  PermissionMode,
  PlanUsage,
  PlanWindow,
  SessionCommand,
  SessionModelInfo,
  SessionSelectors,
} from "@drafthouse/protocol";
import {
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  FileIcon,
  FolderIcon,
  PaperclipIcon,
  StopIcon,
} from "./icons";
import type { SendKey } from "./settings";

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

/**
 * "언제 끝나나" reads best as time left, and one unit is enough on a chip —
 * the exact clock time stays in the tooltip.
 */
function timeLeft(at: string | null): string | null {
  if (!at) return null;
  const minutes = Math.round((new Date(at).getTime() - Date.now()) / 60000);
  if (minutes <= 0) return null;
  if (minutes < 60) return `${minutes}분 남음`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}시간 남음`;
  return `${Math.round(hours / 24)}일 남음`;
}

/**
 * The signed-in plan's rolling limits, straight from the claude.ai usage
 * endpoint: the five-hour window renews fastest, the weekly one is the real
 * ceiling. API-key sessions have no plan, and the pills simply do not render.
 */
function PlanLimits({ plan }: { plan: PlanUsage }) {
  // The countdown is computed from `now`, so a pill rendered once goes stale;
  // re-render on the half-minute while any window is showing.
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(timer);
  }, []);

  const windows: Array<{ label: string; limit: PlanWindow }> = [];
  if (plan.fiveHour) windows.push({ label: "5시간", limit: plan.fiveHour });
  if (plan.sevenDay) windows.push({ label: "이번 주", limit: plan.sevenDay });

  const reset = (at: string | null) =>
    at
      ? ` · ${new Date(at).toLocaleString("ko-KR", {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })}에 다시 채워져요`
      : "";

  return (
    <span className="limits">
      {/* Without a label the pills read as random percentages; naming the
          account they belong to is the one word the tooltip cannot carry. */}
      <span className="limits__label">Claude 사용량</span>
      {windows.map(({ label, limit }) => {
        const pct = Math.max(0, Math.min(100, limit.utilization ?? 0));
        const tone = pct >= 85 ? " limit--danger" : pct >= 60 ? " limit--warn" : "";
        return (
          <span
            key={label}
            className={`limit${tone}`}
            title={`${label} 동안 쓸 수 있는 양의 ${pct}%를 썼어요${reset(limit.resetsAt)}`}
          >
            <span className="limit__dot" />
            {label} {pct}%
            <span className="limit__left">{timeLeft(limit.resetsAt) ?? ""}</span>
          </span>
        );
      })}
    </span>
  );
}

/** Every label here is read by a planner, not a developer: plain Korean only. */
const EFFORT_LABEL: Record<EffortLevel, string> = {
  low: "짧게",
  medium: "보통",
  high: "길게",
  xhigh: "더 길게",
  max: "가장 길게",
};

const EFFORT_HINT: Record<EffortLevel, string> = {
  low: "빨리 답해요",
  medium: "무난하게 생각해요",
  high: "좀 더 생각하고 답해요",
  xhigh: "오래 생각해서 꼼꼼히 답해요",
  max: "가장 오래 생각해요. 그만큼 느려요",
};

const MODE_LABEL: Record<PermissionMode, string> = {
  default: "물어보고 진행",
  plan: "계획만 세우기",
  acceptEdits: "화면 수정은 바로",
  dontAsk: "묻지 않기",
  bypassPermissions: "전부 맡기기",
};

const MODE_HINT: Record<PermissionMode, string> = {
  default: "바꾸기 전에 먼저 확인해요",
  plan: "실제로 바꾸지 않고 무엇을 할지만 알려줘요",
  acceptEdits: "화면 파일 수정은 확인 없이, 나머지는 물어봐요",
  dontAsk: "확인 없이 진행해요",
  bypassPermissions: "확인 없이 알아서 진행해요. 빠른 대신 조심해야 해요",
};

/** dontAsk stays reachable through the API but off the menu: 전부 맡기기 covers it. */
const MODES: PermissionMode[] = ["default", "plan", "acceptEdits", "bypassPermissions"];

/**
 * Planners asked to see which Claude they are choosing, by name. The CLI hands
 * over a short label ("Sonnet") plus a description whose head carries the
 * version the planner also sees in Claude Code ("Sonnet 5 · Efficient for
 * routine tasks"), so the name leads the row and the Korean guidance — the part
 * that tells a non-developer when to reach for it — rides along as the hint.
 */
const MODEL_HINT: Array<{ match: (id: string) => boolean; hint: string }> = [
  { match: (id) => id.includes("fable"), hint: "제일 어려운 작업용. 그만큼 느려요" },
  { match: (id) => id.includes("opus"), hint: "복잡하거나 긴 기획서에 좋아요" },
  { match: (id) => id.includes("sonnet"), hint: "속도와 결과가 균형 잡혀 있어요" },
  { match: (id) => id.includes("haiku"), hint: "간단한 수정에 좋아요" },
];

/** `Sonnet 5 · Efficient…` → `Sonnet 5`; `Opus 5 with 1M context` → `Opus 5 (1M)`. */
function modelName(model: SessionModelInfo): string {
  const head = model.description.split("·")[0]?.trim().replace(/\s+with 1M context$/i, " (1M)");
  return head || model.displayName;
}

function modelWords(model: SessionModelInfo): { label: string; hint: string } {
  const name = modelName(model);
  // Alias rows ("sonnet") and id rows ("claude-sonnet-5") both have to find
  // their family, so whichever the CLI sent is what gets matched.
  const guide = MODEL_HINT.find((entry) =>
    entry.match(`${model.value} ${model.resolvedModel ?? ""}`.toLowerCase()),
  )?.hint;
  // `default` is the CLI's own recommendation, so that is what the row says;
  // the model it resolves to today rides in the hint, where it can change
  // without the chip ever lying about what was picked.
  if (model.value === "default") {
    return { label: "자동 (추천)", hint: `${name} · 대부분의 화면 작업에 알맞아요` };
  }
  return { label: name, hint: guide ?? "" };
}

/**
 * `/`-commands worth offering, in a planner's words. Everything else the CLI
 * advertises is developer or terminal plumbing and stays hidden.
 */
const COMMAND_LABEL: Record<string, { label: string; hint: string }> = {
  clear: { label: "대화 새로 시작", hint: "지금까지 대화를 지우고 처음부터 이야기해요" },
  compact: { label: "대화 정리", hint: "길어진 대화를 요약해서 이어가요" },
  usage: { label: "사용량 보기", hint: "5시간·주간 한도를 얼마나 썼는지 알려줘요" },
  context: { label: "대화 길이 보기", hint: "지금 대화가 얼마나 찼는지 알려줘요" },
};

/** Built-ins that only mean something at a terminal. */
const COMMAND_HIDDEN: Record<string, true> = {
  agents: true,
  bug: true,
  config: true,
  "connect-ide": true,
  doctor: true,
  export: true,
  feedback: true,
  hooks: true,
  ide: true,
  init: true,
  "install-github-app": true,
  login: true,
  logout: true,
  mcp: true,
  memory: true,
  model: true,
  "output-style": true,
  permissions: true,
  "pr-comments": true,
  "privacy-settings": true,
  "release-notes": true,
  resume: true,
  review: true,
  statusline: true,
  status: true,
  "terminal-setup": true,
  todos: true,
  upgrade: true,
  vim: true,
};

/**
 * One Paseo-style selector chip with its dropdown. Options arrive pre-shaped;
 * picked rows carry a check, hints ride on the right.
 */
function SelectorChip({
  label,
  open,
  disabled,
  title,
  onToggle,
  onClose,
  onPick,
  options,
}: {
  label: string;
  open: boolean;
  disabled?: boolean;
  title?: string;
  onToggle: () => void;
  onClose: () => void;
  onPick: (value: string | null) => void;
  options: Array<{ value: string | null; label: string; hint?: string; picked: boolean }>;
}) {
  const chip = useRef<HTMLButtonElement>(null);

  // Escape closes — the one dismissal a keyboard-only planner will try first.
  // Focus returns to the chip, so the next Tab keeps going from where it was.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        chip.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <span className="selector">
      {open && <button type="button" className="selector__backdrop" aria-label="선택 닫기" onClick={onClose} />}
      <button
        ref={chip}
        type="button"
        className="selector__chip"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        title={title}
        onClick={onToggle}
      >
        {label}
        <ChevronDownIcon size={10} />
      </button>
      {open && (
        <span className="selector__menu" role="listbox">
          {options.map((option) => (
            <button
              key={String(option.value)}
              type="button"
              role="option"
              aria-selected={option.picked}
              className="selector__row"
              onClick={() => onPick(option.value)}
            >
              <span className="selector__check">{option.picked ? <CheckIcon size={11} /> : null}</span>
              <span className="selector__label">{option.label}</span>
              {option.hint && <span className="selector__hint">{option.hint}</span>}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Autocomplete for @files
// ---------------------------------------------------------------------------

interface Suggestion {
  insert: string;
  label: string;
  /** Muted second column: a command's description, a file's folder. */
  hint?: string;
  kind: "file" | "dir" | "command";
}

/**
 * Work out whether the caret sits in a sigil token — `@` for files, `/` for
 * commands. Returns the token being typed so the caller can look up matches,
 * plus the span to replace when one is chosen. Attached documents land in
 * `specs/`, so `@specs/…` is how a planner points Claude back at one they
 * sent earlier.
 */
const MENTION_TOKEN = /(^|\s)@(\S*)$/;
const COMMAND_TOKEN = /(^|\s)\/(\S*)$/;

function activeToken(
  text: string,
  caret: number,
  pattern: RegExp,
): { query: string; from: number } | null {
  const at = pattern.exec(text.slice(0, caret));
  if (!at) return null;
  const query = at[2] ?? "";
  return { query, from: caret - query.length - 1 };
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

export interface ComposerQuote {
  title: string;
  heading: string | null;
  text: string;
}

export function Composer({
  commands,
  disabled,
  placeholder,
  usage,
  plan,
  running,
  sendKey,
  quote,
  selector,
  onSetModel,
  onSetEffort,
  onSetPermissionMode,
  onDismissQuote,
  onSend,
  onInterrupt,
  onFindFiles,
  initialText,
  onInitialTextConsumed,
}: {
  disabled: boolean;
  /** /command palette rows, straight from the CLI. */
  commands: SessionCommand[];
  placeholder: string;
  usage: ContextUsage | null;
  /** Account-wide limits from the daemon; shown even with no thread open. */
  plan: PlanUsage | null;
  running: boolean;
  /**
   * 모델·노력·권한 chips. Before a session exists these carry what the next
   * one will start with, so the planner can set the run up while the
   * workspace is still connecting.
   */
  selector: SessionSelectors;
  onSetModel: (model: string | null) => void;
  onSetEffort: (effort: EffortLevel | null) => void;
  onSetPermissionMode: (mode: PermissionMode) => void;
  /** Which keypress sends; the other one inserts a newline. */
  sendKey: SendKey;
  /** A quote dragged out of the planning editor rides along as a chip. */
  quote?: ComposerQuote | null;
  onDismissQuote?: () => void;
  onSend: (text: string, attachments: Attachment[]) => void;
  onInterrupt: () => void;
  onFindFiles: (query: string) => Promise<string[]>;
  /**
   * A draft handed in from outside — the 기획→디자인 handoff writes the first
   * turn for the planner to read and send themselves. Never sends on its own;
   * `nonce` is what makes a repeat of the same text land again.
   */
  initialText?: { text: string; nonce: number } | null;
  onInitialTextConsumed?: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [menu, setMenu] = useState<"model" | "effort" | "mode" | null>(null);
  const [tokenSpan, setTokenSpan] = useState<{ from: number; to: number } | null>(null);
  /** Bumped when a pick moves the caret, so the token is read after the move. */
  const [caretTick, setCaretTick] = useState(0);
  const area = useRef<HTMLTextAreaElement>(null);
  const [highlight, setHighlight] = useState(0);
  const filePicker = useRef<HTMLInputElement>(null);
  const [rejected, setRejected] = useState<string | null>(null);
  /** The last handed-in draft this composer took, so a re-render never re-takes it. */
  const takenNonce = useRef<number | null>(null);

  // A handed-in draft fills the box and takes focus; the planner reads it and
  // presses send. Anything already typed is replaced, which is what a fresh
  // handoff means.
  useEffect(() => {
    if (!initialText || takenNonce.current === initialText.nonce) return;
    takenNonce.current = initialText.nonce;
    setDraft(initialText.text);
    const caret = initialText.text.length;
    requestAnimationFrame(() => {
      const element = area.current;
      if (!element) return;
      element.focus();
      element.setSelectionRange(caret, caret);
    });
    onInitialTextConsumed?.();
  }, [initialText, onInitialTextConsumed]);

  // Grow the textarea with its content, up to the CSS max-height.
  useEffect(() => {
    const element = area.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 220)}px`;
  }, [draft]);

  // Recompute suggestions whenever the caret lands in an @ or / token.
  useEffect(() => {
    const element = area.current;
    if (!element) return;
    const caret = element.selectionStart ?? draft.length;

    const command = activeToken(draft, caret, COMMAND_TOKEN);
    if (command) {
      setTokenSpan({ from: command.from, to: caret });
      setHighlight(0);
      const typed = command.query;
      setSuggestions(
        commands
          .filter(
            ({ name, aliases }) =>
              !COMMAND_HIDDEN[name] &&
              (!typed ||
                name.startsWith(typed) ||
                aliases.some((alias) => alias.startsWith(typed))),
          )
          .slice(0, 10)
          .map((entry) => {
            // Built-ins get a planner's words; a team's own skill keeps its own.
            const known = COMMAND_LABEL[entry.name];
            return {
              insert: `/${entry.name} `,
              label: known ? known.label : `/${entry.name}${entry.argumentHint ? ` ${entry.argumentHint}` : ""}`,
              hint: known ? known.hint : entry.description,
              kind: "command" as const,
            };
          }),
      );
      return;
    }

    const mention = activeToken(draft, caret, MENTION_TOKEN);
    if (!mention) {
      setSuggestions([]);
      setTokenSpan(null);
      return;
    }

    setTokenSpan({ from: mention.from, to: caret });
    setHighlight(0);

    let cancelled = false;
    void onFindFiles(mention.query).then((entries) => {
      if (cancelled) return;
      setSuggestions(
        entries.slice(0, 10).map((entry) => {
          const isFolder = entry.endsWith("/");
          const path = isFolder ? entry.slice(0, -1) : entry;
          const cut = path.lastIndexOf("/");
          return {
            // A folder is a step, not a choice: it keeps the token open on its
            // own contents. A file closes it with a space, ready for the next word.
            insert: isFolder ? `@${entry}` : `@${entry} `,
            label: path.slice(cut + 1),
            ...(cut === -1 ? {} : { hint: path.slice(0, cut) }),
            kind: isFolder ? ("dir" as const) : ("file" as const),
          };
        }),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [draft, onFindFiles, commands, caretTick]);

  const applySuggestion = (suggestion: Suggestion) => {
    if (!tokenSpan) return;
    const next = draft.slice(0, tokenSpan.from) + suggestion.insert + draft.slice(tokenSpan.to);
    setDraft(next);
    if (suggestion.kind !== "dir") {
      setSuggestions([]);
      setTokenSpan(null);
    }
    requestAnimationFrame(() => {
      const element = area.current;
      if (!element) return;
      const caret = tokenSpan.from + suggestion.insert.length;
      element.focus();
      element.setSelectionRange(caret, caret);
      // The caret lands a frame after the draft does; drilling into a folder
      // needs the token recomputed against its final position.
      setCaretTick((tick) => tick + 1);
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

  // Chip labels come from the current row, so an aliased id still names the model.
  const modelRow = selector.models.find(
    (model) => model.value === selector.model || model.resolvedModel === selector.model,
  );
  // A model that ignores 노력 must not offer it; one whose row does not say
  // which levels it takes gets the full set.
  const effortLevels =
    modelRow?.supportedEffortLevels ?? (Object.keys(EFFORT_LABEL) as EffortLevel[]);
  const chips = [
    {
      key: "model" as const,
      label: modelRow ? modelWords(modelRow).label : "자동",
      title: "답변 방식",
      // The list is the CLI's, and only a session (or an earlier one, cached)
      // can supply it. Until then the chip states the default and stays shut.
      disabled: selector.models.length === 0,
      options: [
        {
          value: null,
          label: "자동으로 고르기",
          hint: "Claude Code 기본값을 그대로 써요",
          picked: selector.model == null,
        },
        // The CLI lists an alias row and the pinned id it resolves to as two
        // rows with the same name; the planner would see "Opus 5 (1M)" twice
        // with nothing to choose between. First one wins.
        ...selector.models
          .map((model) => {
            const words = modelWords(model);
            return {
              value: model.value,
              label: words.label,
              ...(words.hint ? { hint: words.hint } : {}),
              picked: model === modelRow,
            };
          })
          .filter((row, index, all) => all.findIndex((other) => other.label === row.label) === index),
      ],
    },
    {
      key: "effort" as const,
      label: selector.effort ? `생각 ${EFFORT_LABEL[selector.effort]}` : "생각 시간",
      title: "얼마나 오래 생각할지",
      disabled: modelRow ? !modelRow.supportsEffort : false,
      options: [
        { value: null, label: "자동", picked: selector.effort == null },
        ...effortLevels.map((level) => ({
          value: level,
          label: EFFORT_LABEL[level],
          hint: EFFORT_HINT[level],
          picked: selector.effort === level,
        })),
      ],
    },
    {
      key: "mode" as const,
      label: MODE_LABEL[selector.permissionMode],
      title: "확인 방식",
      disabled: false,
      options: MODES.map((mode) => ({
        value: mode,
        label: MODE_LABEL[mode],
        hint: MODE_HINT[mode],
        picked: selector.permissionMode === mode,
      })),
    },
  ];

  const pickChip = (key: "model" | "effort" | "mode", value: string | null) => {
    setMenu(null);
    if (key === "model") onSetModel(value);
    else if (key === "effort") onSetEffort((value as EffortLevel | null) ?? null);
    else if (value) onSetPermissionMode(value as PermissionMode);
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
      {plan && <PlanLimits plan={plan} />}

      {suggestions.length > 0 && (
        <div className="autocomplete" role="listbox">
          {suggestions.map((suggestion, index) => (
            <button
              key={suggestion.insert}
              type="button"
              role="option"
              aria-selected={index === highlight}
              className={index === highlight ? "autocomplete__row autocomplete__row--on" : "autocomplete__row"}
              onMouseEnter={() => setHighlight(index)}
              onClick={() => applySuggestion(suggestion)}
            >
              {suggestion.kind !== "command" && (
                <span className="autocomplete__icon">
                  {suggestion.kind === "dir" ? <FolderIcon /> : <FileIcon />}
                </span>
              )}
              <span className="autocomplete__label">{suggestion.label}</span>
              {suggestion.hint && <span className="autocomplete__hint">{suggestion.hint}</span>}
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

      {quote && (
        <div className="chips">
          <span className="chip chip--quote" data-testid="quote-chip">
            <span className="chip__doc">인용</span>
            {quote.title}
            {quote.heading ? ` · ${quote.heading}` : ""}
            <button
              type="button"
              aria-label="인용 지우기"
              className="chip__dismiss"
              onClick={() => onDismissQuote?.()}
            >
              ×
            </button>
          </span>
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
        <span className="selectors">
          {chips.map((chip) => (
            <SelectorChip
              key={chip.key}
              label={chip.label}
              title={chip.title}
              open={menu === chip.key}
              disabled={chip.disabled}
              onToggle={() => setMenu(menu === chip.key ? null : chip.key)}
              onClose={() => setMenu(null)}
              onPick={(value) => pickChip(chip.key, value)}
              options={chip.options}
            />
          ))}
        </span>

        <span className="toolbar__spacer" />

        {usage && <ContextRing usage={usage} />}

        {running ? (
          <button
            type="button"
            className="toolbar__stop"
            aria-label="중지"
            title="중지"
            onClick={onInterrupt}
          >
            <StopIcon size={11} />
          </button>
        ) : (
          <button
            type="button"
            className="composer__send"
            aria-label="보내기"
            disabled={disabled || (!draft.trim() && attachments.length === 0)}
            onClick={submit}
            title={sendKey === "enter" ? "보내기 · Enter" : "보내기 · ⌘/Ctrl+Enter"}
          >
            <ArrowUpIcon size={15} />
          </button>
        )}
      </div>
    </footer>
  );
}
