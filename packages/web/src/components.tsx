import { useState } from "react";
import type { AskQuestion } from "@agent-hub/protocol";
import type { Block, PendingPermission, PendingQuestion } from "./daemon-client";
import { Markdown } from "./Markdown";
import { CheckIcon, CloseIcon, ShieldIcon, SparkIcon, ChevronRightIcon } from "./icons";

// ---------------------------------------------------------------------------
// Transcript blocks
// ---------------------------------------------------------------------------

function preview(value: unknown, max = 240): string {
  if (typeof value === "string") return value.length > max ? `${value.slice(0, max)}…` : value;
  const text = JSON.stringify(value, null, 2) ?? String(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** The one input field that best identifies what a tool call is about. */
function toolHeadline(name: string, input: unknown): string {
  const i = input as Record<string, unknown> | null;
  if (!i || typeof i !== "object") return "";
  for (const key of ["command", "file_path", "path", "pattern", "url", "prompt", "description"]) {
    const value = i[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

type ToolStatus = "running" | "done" | "error";

function ToolBlock({ block }: { block: Extract<Block, { type: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const headline = toolHeadline(block.name, block.input);
  const status: ToolStatus = !block.done ? "running" : block.isError ? "error" : "done";

  return (
    <div className={`tool tool--${status}`}>
      <button className="tool__head" onClick={() => setOpen((v) => !v)} type="button">
        <span className={`tool__chevron${open ? " tool__chevron--open" : ""}`}>
          <ChevronRightIcon />
        </span>
        <span className={`tool__sign tool__sign--${status}`}>
          {status === "running" ? (
            <span className="spinner" />
          ) : status === "error" ? (
            <CloseIcon size={11} />
          ) : (
            <CheckIcon size={11} />
          )}
        </span>
        <span className="tool__name">{block.name}</span>
        {headline && <span className="tool__headline">{headline}</span>}
        {block.agentId && <span className="tag">하위 작업</span>}
        <span className={`tool__status tool__status--${status}`}>
          {status === "running" ? "실행 중…" : status === "error" ? "실패" : ""}
        </span>
      </button>
      {open && (
        <div className="tool__body">
          <div className="tool__label">입력</div>
          <pre>{preview(block.input, 4000)}</pre>
          {block.done && (
            <>
              <div className="tool__label">결과</div>
              <pre>{preview(block.result, 4000)}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A planner never asked for a tool log. One assistant turn's tool calls fold
 * into a single Korean line; the developer-grade blocks are one click away so
 * a stuck turn can still be diagnosed.
 */
const ACTIVITY_BUCKET: Record<string, "file" | "command" | "read"> = {
  Write: "file",
  Edit: "file",
  MultiEdit: "file",
  NotebookEdit: "file",
  Bash: "command",
  Read: "read",
  Glob: "read",
  Grep: "read",
};

function activityLine(tools: Array<Extract<Block, { type: "tool" }>>): string {
  let file = 0;
  let command = 0;
  let read = 0;
  let other = 0;
  for (const tool of tools) {
    const bucket = ACTIVITY_BUCKET[tool.name];
    if (bucket === "file") file += 1;
    else if (bucket === "command") command += 1;
    else if (bucket === "read") read += 1;
    else other += 1;
  }
  const parts: string[] = [];
  if (file) parts.push(`파일 ${file}개 생성`);
  if (command) parts.push(`명령 ${command}개 실행`);
  if (read) parts.push(`조회 ${read}개`);
  if (other) parts.push(`기타 ${other}개`);
  return parts.join(" · ");
}

function ActivitySummary({ tools }: { tools: Array<Extract<Block, { type: "tool" }>> }) {
  const [open, setOpen] = useState(false);
  const running = tools.some((tool) => !tool.done);
  const failed = tools.some((tool) => tool.isError);

  return (
    <div className={failed ? "activity activity--error" : "activity"}>
      <button type="button" className="activity__head" onClick={() => setOpen((v) => !v)}>
        <span className={`tool__chevron${open ? " tool__chevron--open" : ""}`}>
          <ChevronRightIcon />
        </span>
        {running ? <span className="spinner" /> : <CheckIcon size={11} />}
        <span className="activity__text">{activityLine(tools)}</span>
        {failed && <span className="activity__flag">실패 있음</span>}
      </button>
      {open && (
        <div className="activity__body">
          {tools.map((tool) => (
            <ToolBlock key={tool.id} block={tool} />
          ))}
        </div>
      )}
    </div>
  );
}

type Row =
  | { kind: "block"; block: Block }
  | { kind: "activity"; id: string; tools: Array<Extract<Block, { type: "tool" }>> };

/** Runs of adjacent tool blocks become one activity row; anything else ends a run. */
function groupActivity(blocks: Block[]): Row[] {
  const rows: Row[] = [];
  for (const block of blocks) {
    if (block.type !== "tool") {
      rows.push({ kind: "block", block });
      continue;
    }
    const last = rows[rows.length - 1];
    if (last?.kind === "activity") last.tools.push(block);
    else rows.push({ kind: "activity", id: `activity-${block.id}`, tools: [block] });
  }
  return rows;
}

export function Transcript({ blocks }: { blocks: Block[] }) {
  if (blocks.length === 0) {
    return <p className="empty">기획서를 첨부하고 만들고 싶은 화면을 말해 주세요.</p>;
  }
  const rows = groupActivity(blocks);
  return (
    <div className="transcript">
      {rows.map((row) => {
        if (row.kind === "activity") return <ActivitySummary key={row.id} tools={row.tools} />;
        const block = row.block;
        switch (block.type) {
          case "user":
            return (
              <div key={block.id} className="bubble bubble--user">
                {block.text}
                {block.images > 0 && <span className="tag">이미지 {block.images}장</span>}
                {block.files.map((file) => (
                  <span key={file} className="bubble__file">
                    {file.split("/").pop()}
                  </span>
                ))}
              </div>
            );
          case "text":
            return (
              <div key={block.id} className="bubble bubble--assistant">
                <Markdown text={block.text} />
                {block.streaming && <span className="caret" />}
              </div>
            );
          case "thinking":
            return (
              <details key={block.id} className="thinking">
                <summary>생각 중</summary>
                <pre>{block.text}</pre>
              </details>
            );
          case "tool":
            return <ToolBlock key={block.id} block={block} />;
          // Cost and duration are a developer's accounting, not a planner's.
          case "turn":
            return null;
          case "notice":
            return (
              <div key={block.id} className={`notice notice--${block.level}`}>
                <span className="notice__text">{block.text}</span>
              </div>
            );
        }
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Human-in-the-loop cards
// ---------------------------------------------------------------------------

export function PermissionCard({
  request,
  onRespond,
}: {
  request: PendingPermission;
  onRespond: (decision: "allow" | "allowAlways" | "deny", message?: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [showReason, setShowReason] = useState(false);
  const headline = toolHeadline(request.toolName, request.input);
  const suggestion = request.suggestions[0];

  return (
    <div className="card card--permission">
      <div className="card__title">
        <span className="card__badge">
          <ShieldIcon />
        </span>
        <span>
          <strong>{request.toolName}</strong> 실행을 허용할까요?
        </span>
      </div>
      {headline && <pre className="card__headline">{headline}</pre>}
      <details className="card__details">
        <summary>자세히 보기</summary>
        <pre>{preview(request.input, 4000)}</pre>
      </details>

      {showReason ? (
        <div className="card__reason">
          <input
            autoFocus
            value={reason}
            placeholder="왜 안 되는지, 대신 무엇을 할지 알려 주세요"
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onRespond("deny", reason || undefined)}
          />
          <button type="button" onClick={() => onRespond("deny", reason || undefined)}>
            거절 보내기
          </button>
          <button type="button" className="ghost" onClick={() => setShowReason(false)}>
            뒤로
          </button>
        </div>
      ) : (
        <div className="card__actions">
          <button type="button" className="primary" onClick={() => onRespond("allow")}>
            이번만 허용
          </button>
          <button
            type="button"
            disabled={!suggestion}
            title={suggestion ? suggestion.label : "이 동작은 계속 물어볼 수밖에 없습니다"}
            onClick={() => onRespond("allowAlways")}
          >
            {suggestion ? `항상 허용 · ${suggestion.label}` : "항상 허용"}
          </button>
          <button type="button" className="danger" onClick={() => setShowReason(true)}>
            거절…
          </button>
        </div>
      )}
    </div>
  );
}

export function QuestionCard({
  request,
  onRespond,
}: {
  request: PendingQuestion;
  onRespond: (answers: Record<string, string | string[]>) => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});

  const pick = (q: AskQuestion, label: string) => {
    setAnswers((prev) => {
      if (!q.multiSelect) return { ...prev, [q.question]: label };
      const current = prev[q.question];
      const list = Array.isArray(current) ? current : current ? [current] : [];
      return {
        ...prev,
        [q.question]: list.includes(label) ? list.filter((l) => l !== label) : [...list, label],
      };
    });
  };

  const isPicked = (q: AskQuestion, label: string) => {
    const current = answers[q.question];
    return Array.isArray(current) ? current.includes(label) : current === label;
  };

  const merged = (): Record<string, string | string[]> => {
    const out = { ...answers };
    for (const [question, text] of Object.entries(custom)) {
      if (text.trim()) out[question] = text.trim();
    }
    return out;
  };

  const complete = request.questions.every((q) => {
    const value = merged()[q.question];
    return Array.isArray(value) ? value.length > 0 : Boolean(value);
  });

  return (
    <div className="card card--question">
      <div className="card__title">
        <span className="card__badge">
          <SparkIcon size={14} />
        </span>
        <span>확인이 필요합니다</span>
      </div>
      {request.questions.map((q) => (
        <div key={q.question} className="question">
          <div className="question__header">{q.header}</div>
          <div className="question__text">{q.question}</div>
          <div className="question__options">
            {q.options.map((option) => (
              <button
                key={option.label}
                type="button"
                className={isPicked(q, option.label) ? "option option--picked" : "option"}
                onClick={() => pick(q, option.label)}
              >
                <span className="option__label">{option.label}</span>
                <span className="option__description">{option.description}</span>
              </button>
            ))}
          </div>
          <input
            className="question__custom"
            placeholder="기타: 직접 입력"
            value={custom[q.question] ?? ""}
            onChange={(e) => setCustom((prev) => ({ ...prev, [q.question]: e.target.value }))}
          />
        </div>
      ))}
      <div className="card__actions">
        <button
          type="button"
          className="primary"
          disabled={!complete}
          onClick={() => onRespond(merged())}
        >
          답변 보내기
        </button>
      </div>
    </div>
  );
}
