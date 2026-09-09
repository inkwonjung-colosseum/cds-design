/**
 * Markdown body ↔ TipTap/ProseMirror JSON for the planning editor.
 *
 * The grammar is exactly the one the daemon's converter emits (DESIGN §4.3:
 * 지원 부분집합 — headings, paragraphs, lists, tables, code, links, images,
 * hard breaks, hr; everything else arrives as a ` ```confluence ` fence and
 * becomes an atomic node). The daemon stays the single normalizer: whatever
 * this layer produces goes through doc.save's markdown→storage→markdown
 * round-trip, so editor-side drift cannot reach the mirror un-canonicalized.
 *
 * Pure data: no DOM, no editor imports — easy to reason about and to test.
 */

export interface PMNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  text?: string;
}

const ESCAPABLE = new Set(["\\", "`", "*", "_", "[", "]", "<", ">"]);

// ---------------------------------------------------------------------------
// markdown → ProseMirror
// ---------------------------------------------------------------------------

export function markdownToDoc(body: string): PMNode {
  const lines = body.split("\n");
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  const parser = new BlockParser(lines);
  return { type: "doc", content: parser.blocks() };
}

class BlockParser {
  private at = 0;

  constructor(private readonly lines: string[]) {}

  blocks(): PMNode[] {
    const nodes: PMNode[] = [];
    let paragraph: string[] = [];
    const flush = () => {
      if (paragraph.length === 0) return;
      nodes.push(paragraphNode(paragraph));
      paragraph = [];
    };

    while (this.at < this.lines.length) {
      const line = this.lines[this.at]!;

      if (line.trim() === "") {
        this.at += 1;
        flush();
        continue;
      }

      const fenceRun = fenceLength(line);
      if (fenceRun > 0) {
        flush();
        nodes.push(...this.fenceBlock(fenceRun, fenceInfo(line)));
        continue;
      }

      if (/^---+$/.test(line)) {
        flush();
        nodes.push({ type: "horizontalRule" });
        this.at += 1;
        continue;
      }

      const heading = /^(#{1,6}) (.*)$/.exec(line);
      if (heading) {
        flush();
        nodes.push({
          type: "heading",
          attrs: { level: heading[1]!.length },
          content: inline(heading[2]!),
        });
        this.at += 1;
        continue;
      }

      if (listMarker(line)) {
        flush();
        nodes.push(this.listBlock());
        continue;
      }

      if (line.startsWith("|")) {
        const table = this.tableBlock();
        if (table) {
          flush();
          nodes.push(table);
          continue;
        }
      }

      paragraph.push(line);
      this.at += 1;
    }
    flush();
    return nodes;
  }

  /** Called with `this.at` still on the opening delimiter. */
  private fenceBlock(run: number, info: string): PMNode[] {
    this.at += 1;
    const content: string[] = [];
    while (this.at < this.lines.length) {
      const line = this.lines[this.at]!;
      this.at += 1;
      if (fenceLength(line) === run && fenceInfo(line) === "") break;
      content.push(line);
    }
    const text = content.join("\n");
    if (info === "confluence") {
      return [{ type: "confluenceBlock", attrs: { xml: text, label: confluenceLabel(text) } }];
    }
    return [
      {
        type: "codeBlock",
        attrs: { language: info || null },
        content: text.length === 0 ? [] : [{ type: "text", text }],
      },
    ];
  }

  private listBlock(): PMNode {
    const first = listMarker(this.lines[this.at]!)!;
    const depth = first.pad;
    const ordered = first.ordered;
    const items: PMNode[] = [];

    while (this.at < this.lines.length) {
      const marker = listMarker(this.lines[this.at]!);
      if (!marker || marker.pad < depth || marker.ordered !== ordered) break;
      if (marker.pad > depth) break;

      this.at += 1;
      const parts: string[] = [marker.text];
      while (this.at < this.lines.length) {
        const next = this.lines[this.at]!;
        if (listMarker(next)) break;
        if (/^\s{2,}\S/.test(next)) {
          parts.push(`  \n${next.trim()}`);
          this.at += 1;
          continue;
        }
        break;
      }
      const item: PMNode = { type: "listItem", content: [{ type: "paragraph", content: inline(parts.join("")) }] };

      while (this.at < this.lines.length) {
        const nested = listMarker(this.lines[this.at]!);
        if (!nested || nested.pad <= depth) break;
        const sub = this.listBlock();
        if (!sub) break;
        item.content!.push(sub);
      }
      items.push(item);
    }
    return { type: ordered ? "orderedList" : "bulletList", content: items };
  }

  private tableBlock(): PMNode | null {
    const start = this.at;
    const rows: string[][] = [];
    let sawSeparator = false;

    while (this.at < this.lines.length && this.lines[this.at]!.startsWith("|")) {
      const line = this.lines[this.at]!;
      if (/^\|(?: ?-{3,} ?\|)+$/.test(line.replace(/\s+/g, " ").trim())) {
        sawSeparator = true;
        this.at += 1;
        continue;
      }
      rows.push(splitTableRow(line));
      this.at += 1;
    }

    if (rows.length < 1 || !sawSeparator) {
      this.at = start;
      return null;
    }
    const [header, ...bodyRows] = rows;
    return {
      type: "table",
      content: [
        {
          type: "tableRow",
          content: header!.map((cell) => cellNode(cell, "tableHeader")),
        },
        ...bodyRows.map((cells) => ({
          type: "tableRow",
          content: cells.map((cell) => cellNode(cell, "tableCell")),
        })),
      ],
    };
  }
}

function cellNode(cell: string, type: "tableHeader" | "tableCell"): PMNode {
  return { type, content: [{ type: "paragraph", content: inline(cell) }] };
}

function paragraphNode(lines: string[]): PMNode {
  const content: PMNode[] = [];
  lines.forEach((line, index) => {
    const hardBreak = line.endsWith("  ") && index < lines.length - 1;
    const text = hardBreak ? line.slice(0, -2) : line;
    content.push(...inline(text));
    if (hardBreak) content.push({ type: "hardBreak" });
  });
  // A lone image paragraph is a block image; anything else stays a paragraph.
  if (content.length === 1 && content[0]!.type === "image") return content[0]!;
  return { type: "paragraph", content };
}

// ---------------------------------------------------------------------------
// ProseMirror → markdown
// ---------------------------------------------------------------------------

export function docToMarkdown(doc: PMNode): string {
  const blocks = (doc.content ?? []).map(nodeToBlock).filter(Boolean);
  return blocks.length === 0 ? "" : `${blocks.join("\n\n")}\n`;
}

function nodeToBlock(node: PMNode): string | null {
  switch (node.type) {
    case "heading":
      return `${"#".repeat(Number(node.attrs?.level ?? 1))} ${serializeInline(node.content ?? [])}`;
    case "paragraph": {
      const text = serializeInline(node.content ?? []);
      return text.trim() === "" ? null : text;
    }
    case "bulletList":
    case "orderedList":
      return serializeList(node, 0);
    case "codeBlock": {
      const code = (node.content ?? []).map((child) => child.text ?? "").join("");
      const language = String(node.attrs?.language ?? "");
      return fence(code, language);
    }
    case "confluenceBlock":
      return fence(String(node.attrs?.xml ?? ""), "confluence");
    case "table":
      return serializeTable(node);
    case "horizontalRule":
      return "---";
    case "image": {
      const alt = String(node.attrs?.alt ?? "");
      const src = String(node.attrs?.src ?? "");
      return `![${escapeInline(alt)}](${src})`;
    }
    default:
      return null;
  }
}

function serializeList(node: PMNode, depth: number): string {
  const ordered = node.type === "orderedList";
  const items: string[] = [];
  let index = 0;
  for (const item of node.content ?? []) {
    index += 1;
    const pad = " ".repeat(depth * 4);
    const marker = ordered ? `${index}. ` : "- ";
    const parts: string[] = [];
    const nested: PMNode[] = [];
    for (const child of item.content ?? []) {
      if (child.type === "bulletList" || child.type === "orderedList") nested.push(child);
      else if (child.type === "paragraph") parts.push(serializeInline(child.content ?? []));
    }
    const head = `${pad}${marker}${parts.join("  \n")}`;
    items.push(nested.length > 0 ? [head, ...nested.map((list) => serializeList(list, depth + 1))].join("\n") : head);
  }
  return items.join("\n");
}

function serializeTable(node: PMNode): string {
  const rows = (node.content ?? []).map((row) =>
    (row.content ?? []).map((cell) =>
      serializeInline((cell.content ?? []).flatMap((child) => child.content ?? [])).trim(),
    ),
  );
  if (rows.length === 0) return "";
  const line = (cells: string[]) => `| ${cells.map((cell) => cell.replace(/\|/g, "\\|")).join(" | ")} |`;
  return [line(rows[0]!), `| ${rows[0]!.map(() => "---").join(" | ")} |`, ...rows.slice(1).map(line)].join("\n");
}

function serializeInline(nodes: PMNode[]): string {
  const parts: string[] = [];
  for (const node of nodes) {
    if (node.type === "text") {
      parts.push(withMarks(escapeInline(node.text ?? ""), node.marks ?? []));
      continue;
    }
    if (node.type === "hardBreak") {
      parts.push("  \n");
      continue;
    }
    if (node.type === "image") {
      const alt = String(node.attrs?.alt ?? "");
      const src = String(node.attrs?.src ?? "");
      parts.push(`![${escapeInline(alt)}](${src})`);
      continue;
    }
  }
  return parts.join("");
}

/** Applies a mark set to already-escaped text; nesting mirrors the grammar. */
function withMarks(text: string, marks: Array<{ type: string; attrs?: Record<string, unknown> }>): string {
  if (text === "") return text;
  let out = text;
  for (const mark of marks) {
    if (mark.type === "bold") out = `**${out}**`;
    else if (mark.type === "italic") out = `*${out}*`;
    else if (mark.type === "code") out = out.includes("`") ? out : `\`${out}\``;
    else if (mark.type === "link") out = `[${out}](${String(mark.attrs?.href ?? "")})`;
  }
  const order = marks.map((mark) => mark.type);
  if (order.includes("code") && order.length > 1) {
    // `[**\`x\`**](u)` style nests confuse the parser; code wins alone.
    return `\`${text.replace(/[`\\]/g, "")}\``;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Inline markdown → PM inline nodes
// ---------------------------------------------------------------------------

function inline(text: string): PMNode[] {
  const nodes: PMNode[] = [];
  let buffer = "";
  const flush = () => {
    if (buffer) {
      nodes.push({ type: "text", text: buffer });
      buffer = "";
    }
  };

  for (let i = 0; i < text.length; ) {
    const char = text[i]!;

    if (char === "\\" && ESCAPABLE.has(text[i + 1] ?? "")) {
      buffer += text[i + 1]!;
      i += 2;
      continue;
    }

    if (char === "`") {
      let run = 0;
      while (text[i + run] === "`") run += 1;
      const close = findCodeClose(text, i + run, run);
      if (close >= 0) {
        flush();
        nodes.push({ type: "text", text: text.slice(i + run, close), marks: [{ type: "code" }] });
        i = close + run;
        continue;
      }
    }

    if (char === "!" && text[i + 1] === "[") {
      const link = parseLink(text, i + 1);
      if (link) {
        flush();
        nodes.push({
          type: "image",
          attrs: { src: link.url, alt: unescapeText(link.label) },
        });
        i = link.end;
        continue;
      }
    }

    if (char === "[") {
      const link = parseLink(text, i);
      if (link) {
        flush();
        const inner = inline(link.label);
        if (inner.length > 0) {
          for (const node of inner) {
            node.marks = [{ type: "link", attrs: { href: link.url } }, ...(node.marks ?? [])];
            nodes.push(node);
          }
        } else {
          nodes.push({ type: "text", text: unescapeText(link.label), marks: [{ type: "link", attrs: { href: link.url } }] });
        }
        i = link.end;
        continue;
      }
    }

    if (char === "*" && text[i + 1] === "*") {
      const close = text.indexOf("**", i + 2);
      if (close > i + 1) {
        flush();
        nodes.push(...inline(text.slice(i + 2, close)).map((node) => ({ ...node, marks: [{ type: "bold" }, ...(node.marks ?? [])] })));
        i = close + 2;
        continue;
      }
    }

    if (char === "*" && text[i + 1] !== " " && text.indexOf("*", i + 1) > 0) {
      const close = text.indexOf("*", i + 1);
      if (close > i) {
        flush();
        nodes.push(...inline(text.slice(i + 1, close)).map((node) => ({ ...node, marks: [{ type: "italic" }, ...(node.marks ?? [])] })));
        i = close + 1;
        continue;
      }
    }

    buffer += char;
    i += 1;
  }
  flush();
  return nodes;
}

function findCodeClose(text: string, from: number, run: number): number {
  for (let i = from; i <= text.length - run; i += 1) {
    if (text[i] !== "`") continue;
    let seen = 0;
    while (text[i + seen] === "`") seen += 1;
    if (seen === run) return i;
    i += seen - 1;
  }
  return -1;
}

function parseLink(text: string, at: number): { label: string; url: string; end: number } | null {
  if (text[at] !== "[") return null;
  let depth = 0;
  let inCode = false;
  for (let i = at; i < text.length; i += 1) {
    const char = text[i]!;
    if (char === "\\") {
      i += 1;
      continue;
    }
    if (char === "`") inCode = !inCode;
    if (inCode) continue;
    if (char === "[") depth += 1;
    else if (char === "]") {
      depth -= 1;
      if (depth !== 0) continue;
      if (text[i + 1] !== "(") return null;
      const close = text.indexOf(")", i + 2);
      if (close < 0) return null;
      return { label: text.slice(at + 1, i), url: text.slice(i + 2, close), end: close + 1 };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Shared small helpers
// ---------------------------------------------------------------------------

function fenceLength(line: string): number {
  const match = /^(`{3,})/.exec(line);
  return match ? match[1]!.length : 0;
}

function fenceInfo(line: string): string {
  return line.replace(/^`{3,}/, "").trim();
}

function listMarker(line: string): { pad: number; ordered: boolean; text: string } | null {
  const match = /^(\s*)(- |\* |\d+\. )(.*)$/.exec(line);
  if (!match) return null;
  return { pad: Math.floor(match[1]!.length / 4), ordered: /\d/.test(match[2]!), text: match[3]! };
}

function splitTableRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);
  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\\" && text[i + 1] === "|") {
      current += "|";
      i += 1;
      continue;
    }
    if (text[i] === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += text[i]!;
  }
  cells.push(current.trim());
  return cells;
}

export function escapeInline(text: string, options: { table?: boolean } = {}): string {
  let out = "";
  for (const char of text) {
    if (ESCAPABLE.has(char)) out += `\\${char}`;
    else if (options.table && char === "|") out += "\\|";
    else out += char;
  }
  const marker = /^([#>+-]|\d+)([.)] )?/.exec(out);
  if (marker) {
    if (/^\d/.test(marker[0])) out = out.replace(/^(\d+)([.)] )/, "$1\\$2");
    else out = `\\${out}`;
  }
  return out;
}

function unescapeText(text: string): string {
  return text.replace(/\\(.)/g, "$1");
}

function fence(content: string, info: string): string {
  let longest = 2;
  for (const match of content.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  const marker = "`".repeat(longest + 1);
  return `${marker}${info}\n${content}\n${marker}`;
}

/** The grey card's label for a preserved block. */
export function confluenceLabel(xml: string): string {
  const match = /<([\w:-]+)([^>]*)>/.exec(xml.trim());
  if (!match) return "Confluence 요소";
  const [, tag, attrs = ""] = match as RegExpExecArray & [string, string, string];
  if (tag === "ac:structured-macro") {
    const name = /ac:name="([^"]+)"/.exec(attrs)?.[1] ?? "매크로";
    return `매크로 ${name}`;
  }
  if (tag === "table" || tag === "tbody" || tag === "thead") return "병합 셀 표";
  if (tag === "ac:layout" || tag.startsWith("ac:layout")) return "레이아웃";
  if (tag === "p") return "Confluence 요소";
  return `Confluence 요소 · ${tag}`;
}
