/**
 * Confluence storage XHTML ↔ hybrid Markdown converter.
 *
 * The on-disk format (DESIGN §4.2): YAML frontmatter (`pageId` `version`
 * `space` `title` `parentPageId`) + a Markdown body. Anything Markdown cannot
 * represent — macros other than the code macro, merged table cells, layouts,
 * rich links, emoticons, images with layout attributes — is preserved
 * VERBATIM as a ` ```confluence ` fenced block containing the original
 * storage XML source slice.
 *
 * ── The contract ──────────────────────────────────────────────────────────
 * `markdownToStorage(storageToMarkdown(x))` reproduces the original storage,
 * and `storageToMarkdown(markdownToStorage(m))` reproduces the markdown,
 * under these documented normalizations (and no others):
 *
 * 1. Storage is emitted compactly: no whitespace between elements, attributes
 *    in source order, canonical entity escaping (`&`, `<`, `>` in text; plus
 *    `"` in attributes). Preserved blocks are the *original source slice*,
 *    byte for byte.
 * 2. Markdown uses LF endings, exactly one blank line between blocks, and
 *    exactly one trailing newline. Line endings are normalized once on the
 *    way in (CRLF/CR → LF), on both sides — XML per spec 2.11, markdown per
 *    CommonMark — so neither direction can carry a stray \r.
 * 3. Text inside a paragraph/list item is trimmed at its edges; interior
 *    text is verbatim. Emphasis runs trim their inner edges the same way.
 * 4. `<br/>` ↔ a line ending in two trailing spaces (a Markdown hard break).
 * 5. A table converts to a Markdown table only when it is exactly
 *    `<table><thead><tr><th>…</th></tr></thead><tbody><tr><td>…</td></tr>…</tbody></table>`
 *    with no colspan/rowspan, no cell attributes and no nested tables —
 *    Markdown tables have a header row by definition, so a table without a
 *    `<th>` row is preserved verbatim rather than inventing one.
 * 6. The code macro ↔ a fenced code block; its language parameter survives.
 *    Every other macro is preserved verbatim.
 * 7. Attachment images ↔ `![alt](<attachmentsDir>/<filename>)`; external
 *    images ↔ their URL. Images referencing another page's attachment, or
 *    carrying layout attributes, are preserved verbatim.
 * 8. Markdown metacharacters in text are backslash-escaped on the way out
 *    and unescaped on the way back; that is the only text munging.
 *
 * The Markdown this parses is the Markdown this emits (plus what an editor
 * would write within the same subset) — it is a line grammar for the block
 * shapes above, not a general Markdown implementation.
 *
 * The converter is pure (string → string) so the editor story can reuse it.
 */

import {
  isElement,
  parseXmlFragment,
  serializeXml,
  sourceSlice,
  textContent,
  type XmlElement,
  type XmlNode,
} from "./xml.js";

// ---------------------------------------------------------------------------
// Page metadata (frontmatter)
// ---------------------------------------------------------------------------

export interface PageMeta {
  pageId: string;
  version: number;
  space: string;
  title: string;
  parentPageId: string | null;
}

export function renderFrontmatter(meta: PageMeta): string {
  return [
    "---",
    `pageId: ${quote(meta.pageId)}`,
    `version: ${meta.version}`,
    `space: ${quote(meta.space)}`,
    `title: ${quote(meta.title)}`,
    `parentPageId: ${meta.parentPageId === null ? "null" : quote(meta.parentPageId)}`,
    "---",
    "",
  ].join("\n");
}

function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function unquote(value: string): string {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value;
  return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

/** Splits frontmatter from the body; tolerant of a body-only document. */
export function parseFrontmatter(markdown: string): { meta: Partial<PageMeta>; body: string } {
  const lines = markdown.split("\n");
  if (lines[0] !== "---") return { meta: {}, body: markdown };
  const end = lines.indexOf("---", 1);
  if (end < 0) return { meta: {}, body: markdown };

  const meta: Record<string, string | number | null> = {};
  for (const line of lines.slice(1, end)) {
    const match = /^(\w+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const value = match[2]!.trim();
    meta[match[1]!] = value === "null" ? null : /^-?\d+$/.test(value) ? Number(value) : unquote(value);
  }
  return {
    meta: meta as Partial<PageMeta>,
    body: lines.slice(end + 1).join("\n").replace(/^\n+/, ""),
  };
}

// ---------------------------------------------------------------------------
// Fences
// ---------------------------------------------------------------------------

/** A fence must be longer than any backtick run inside the content. */
function fence(content: string, info: string): string {
  let longest = 2;
  for (const match of content.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  const marker = "`".repeat(longest + 1);
  return `${marker}${info}\n${content}\n${marker}`;
}

function fenceLength(line: string): number {
  const match = /^(`{3,})/.exec(line);
  return match ? match[1]!.length : 0;
}

function fenceInfo(line: string): string {
  return line.replace(/^`{3,}/, "").trim();
}

// ---------------------------------------------------------------------------
// storage → markdown
// ---------------------------------------------------------------------------

const HEADING_LEVEL: Record<string, number> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };
const CODE_MACRO = "code";
const TABLE_CELL_ATTRS = new Set(["colspan", "rowspan", "class", "style", "data-highlight-color"]);

export function storageToMarkdown(storage: string, meta: PageMeta, attachmentsDir: string): string {
  const doc = new StorageDocument(storage, attachmentsDir);
  const blocks: string[] = [];
  for (const node of parseXmlFragment(storage)) {
    const block = doc.block(node);
    if (block !== null) blocks.push(block);
  }
  const body = blocks.join("\n\n");
  return `${renderFrontmatter(meta)}\n${body}${body === "" ? "" : "\n"}`;
}

/** Carries the source (for verbatim slices) and the attachment folder. */
class StorageDocument {
  constructor(
    private readonly source: string,
    private readonly attachmentsDir: string,
  ) {}

  /** One Markdown block (possibly multi-line) for one storage node, or null. */
  block(node: XmlNode): string | null {
    if (!isElement(node)) return null;
    if (HEADING_LEVEL[node.name] !== undefined) {
      const inline = this.inline(node.children);
      return inline === null
        ? this.verbatim(node)
        : `${"#".repeat(HEADING_LEVEL[node.name]!)} ${inline}`;
    }
    if (node.name === "p") {
      const inline = this.inline(node.children);
      if (inline === null || inline.trim() === "") return this.verbatim(node);
      return trimParagraph(inline);
    }
    if (node.name === "ul" || node.name === "ol") {
      return this.list(node, 0) ?? this.verbatim(node);
    }
    if (node.name === "table") {
      return this.table(node) ?? this.verbatim(node);
    }
    if (node.name === "hr") return "---";
    if (node.name === "ac:image") {
      return this.image(node) ?? this.verbatim(node);
    }
    if (node.name === "ac:structured-macro") {
      return node.attrs["ac:name"] === CODE_MACRO ? this.codeMacro(node) : this.verbatim(node);
    }
    return this.verbatim(node);
  }

  private codeMacro(node: XmlElement): string {
    const language = node.children.find(
      (child) => isElement(child) && child.name === "ac:parameter" && child.attrs["ac:name"] === "language",
    );
    const body = node.children.find((child) => isElement(child) && child.name === "ac:plain-text-body");
    const code = body && isElement(body) ? textContent(body.children) : "";
    const info = language && isElement(language) ? textContent(language.children).trim() : "";
    return fence(code, info);
  }

  private image(node: XmlElement): string | null {
    const refs = node.children.filter(isElement);
    if (refs.length !== 1) return null;
    if (!Object.keys(node.attrs).every((attr) => attr === "ac:alt")) return null;
    const alt = node.attrs["ac:alt"] ?? "";
    const ref = refs[0]!;
    if (ref.name === "ri:attachment" && Object.keys(ref.attrs).every((attr) => attr === "ri:filename")) {
      return `![${escapeInline(alt)}](${this.attachmentsDir}/${ref.attrs["ri:filename"]!})`;
    }
    if (ref.name === "ri:url" && Object.keys(ref.attrs).every((attr) => attr === "ri:value")) {
      return `![${escapeInline(alt)}](${escapeUrl(ref.attrs["ri:value"]!)})`;
    }
    return null;
  }

  private list(node: XmlElement, depth: number): string | null {
    const ordered = node.name === "ol";
    const items: string[] = [];
    let index = 0;
    for (const child of node.children) {
      if (!isElement(child)) continue;
      if (child.name === "li") {
        index += 1;
        const item = this.listItem(child, depth, ordered ? `${index}. ` : "- ");
        if (item === null) return null;
        items.push(item);
      } else {
        // Confluence never mixes list children with anything else.
        return null;
      }
    }
    return items.length === 0 ? null : items.join("\n");
  }

  private listItem(li: XmlElement, depth: number, marker: string): string | null {
    const lines: string[] = [];
    const nested: XmlElement[] = [];
    for (const child of li.children) {
      if (isElement(child) && (child.name === "ul" || child.name === "ol")) {
        nested.push(child);
        continue;
      }
      if (isElement(child) && child.name === "p") {
        // Confluence wraps list text in <p>; several <p> in one item are hard
        // line breaks, which is how the editor writes them.
        const inline = this.inline(child.children);
        if (inline === null) return null;
        lines.push(...splitHardBreaks(inline));
        continue;
      }
      if (isElement(child) && child.name === "br") {
        lines.push("  \n");
        continue;
      }
      if (!isElement(child)) {
        const inline = this.inline([child]);
        if (inline === null) return null;
        lines.push(...splitHardBreaks(inline));
        continue;
      }
      return null;
    }
    const nestedBlocks = nested.map((list) => this.list(list, depth + 1));
    if (nestedBlocks.some((block) => block === null)) return null;

    const pad = " ".repeat(depth * 4);
    const text = lines.join("  \n").trimEnd();
    const head = `${pad}${marker}${text}`.replace(/\s+$/, "");
    return nestedBlocks.length === 0 ? head : [head, ...nestedBlocks.filter((b): b is string => b !== null)].join("\n");
  }

  /** Markdown-shaped tables only; see the contract note 5. */
  private table(node: XmlElement): string | null {
    const sections = node.children.filter(isElement);
    if (sections.length !== 2 || sections[0]!.name !== "thead" || sections[1]!.name !== "tbody") return null;

    const headerRows = sections[0]!.children.filter(isElement);
    if (headerRows.length !== 1 || headerRows[0]!.name !== "tr") return null;
    const header = this.rowCells(headerRows[0]!, "th");
    if (header === null) return null;

    const bodyRows: string[][] = [];
    for (const row of sections[1]!.children.filter(isElement)) {
      if (row.name !== "tr") return null;
      const cells = this.rowCells(row, "td");
      if (cells === null) return null;
      bodyRows.push(cells);
    }
    if (bodyRows.some((cells) => cells.length !== header.length)) return null;

    const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
    return [line(header), `| ${header.map(() => "---").join(" | ")} |`, ...bodyRows.map(line)].join("\n");
  }

  private rowCells(row: XmlElement, expected: "th" | "td"): string[] | null {
    const cells: string[] = [];
    for (const cell of row.children.filter(isElement)) {
      if (cell.name !== expected) return null;
      if (Object.keys(cell.attrs).some((attr) => TABLE_CELL_ATTRS.has(attr))) return null;
      const inline = this.inline(cell.children, { table: true });
      if (inline === null) return null;
      cells.push(inline.trim());
    }
    return cells.length === 0 ? null : cells;
  }

  verbatim(node: XmlElement): string {
    return fence(sourceSlice(this.source, node), "confluence");
  }

  /**
   * Inline content → Markdown text with hard breaks as trailing double
   * spaces. Returns null when something inside cannot be represented — the
   * caller then preserves the enclosing block verbatim.
   */
  inline(nodes: readonly XmlNode[], options: { table?: boolean } = {}): string | null {
    const parts: string[] = [];
    for (const node of nodes) {
      if (node.type === "text" || node.type === "cdata") {
        parts.push(escapeInline(node.value, options));
        continue;
      }
      if (node.name === "strong" || node.name === "b") {
        const inner = this.inline(node.children, options);
        if (inner === null) return null;
        parts.push(`**${inner.trim()}**`);
        continue;
      }
      if (node.name === "em" || node.name === "i") {
        const inner = this.inline(node.children, options);
        if (inner === null) return null;
        parts.push(`*${inner.trim()}*`);
        continue;
      }
      if (node.name === "code") {
        const value = textContent(node.children);
        if (value.includes("`")) return null; // long inline code: not worth the edge cases
        parts.push(`\`${value}\``);
        continue;
      }
      if (node.name === "br") {
        parts.push("  \n");
        continue;
      }
      if (node.name === "a") {
        const href = node.attrs["href"];
        // Rich Confluence links carry <ac:link> children; only plain anchors
        // with exactly an href convert.
        if (!href || Object.keys(node.attrs).length !== 1 || node.children.some(isElement)) return null;
        const inner = this.inline(node.children, options);
        if (inner === null) return null;
        parts.push(`[${inner.trim()}](${escapeUrl(href)})`);
        continue;
      }
      if (node.name === "ac:image") {
        const image = this.image(node);
        if (image === null) return null;
        parts.push(image);
        continue;
      }
      return null; // ac:link, ac:emoticon, styled spans, …: preserve the block
    }
    return parts.join("");
  }
}

/** Splits inline text on the hard-break markers so list items stay one line. */
function splitHardBreaks(inline: string): string[] {
  return inline.split("  \n");
}

/** Contract note 3: paragraph edges trimmed, a trailing hard break kept. */
function trimParagraph(inline: string): string {
  let value = inline.replace(/^[ \t]+/, "");
  if (value.endsWith("  \n")) {
    value = `${value.slice(0, -3).replace(/[ \t]+$/, "")}  \n`;
  } else {
    value = value.replace(/[ \t]+$/, "");
  }
  return value;
}

// ---------------------------------------------------------------------------
// markdown → storage
// ---------------------------------------------------------------------------

export function markdownToStorage(
  markdown: string,
  attachmentsDir: string,
): { meta: Partial<PageMeta>; storage: string } {
  // CommonMark line endings: CRLF and lone CR both become LF, once, on the
  // way in — the same normalization the XML side applies, so a Windows
  // editor's hard break cannot leave a stray CR in a paragraph.
  markdown = markdown.replace(/\r\n?/g, "\n");
  const { meta, body } = parseFrontmatter(markdown);
  const doc = new MarkdownDocument(body, attachmentsDir);
  return { meta, storage: serializeXml(doc.blocks()) };
}

class MarkdownDocument {
  private readonly lines: string[];
  private at = 0;

  constructor(
    body: string,
    private readonly attachmentsDir: string,
  ) {
    this.lines = body.split("\n");
    while (this.lines.length > 0 && this.lines[this.lines.length - 1]!.trim() === "") this.lines.pop();
  }

  blocks(): XmlNode[] {
    const nodes: XmlNode[] = [];
    let paragraph: string[] = [];

    const flush = () => {
      if (paragraph.length === 0) return;
      nodes.push(paragraphNode(paragraph, this.attachmentsDir));
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
        this.at += 1; // the opening line itself is not content
        nodes.push(...this.fenceBlock(fenceRun, fenceInfo(line)));
        continue;
      }

      if (/^---+$/.test(line)) {
        flush();
        nodes.push(el("hr"));
        this.at += 1;
        continue;
      }

      const heading = /^(#{1,6}) (.*)$/.exec(line);
      if (heading) {
        flush();
        nodes.push(el(`h${heading[1]!.length}`, inlineNodes(heading[2]!, this.attachmentsDir)));
        this.at += 1;
        continue;
      }

      if (listMarker(line) !== null) {
        const list = this.listBlock();
        if (list) {
          flush();
          nodes.push(list);
          continue;
        }
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

  /** Fenced blocks: verbatim Confluence storage, or a code macro. */
  private fenceBlock(run: number, info: string): XmlNode[] {
    const content: string[] = [];
    while (this.at < this.lines.length) {
      const line = this.lines[this.at]!;
      this.at += 1;
      if (fenceLength(line) === run && fenceInfo(line) === "") break;
      content.push(line);
    }
    const value = content.join("\n");
    if (info === "confluence") {
      // The stored slice is storage XML already; reparse it so it rejoins the
      // tree and survives serializeXml byte for byte.
      return parseXmlFragment(value);
    }
    return [
      el(
        "ac:structured-macro",
        [
          ...(info ? [el("ac:parameter", [txt(info)], { "ac:name": "language" })] : []),
          el("ac:plain-text-body", [{ type: "cdata", value }]),
        ],
        { "ac:name": "code" },
      ),
    ];
  }

  /**
   * One list (at the depth of the current line), consuming its items and any
   * nested lists under them. Returns null when the current line is not a
   * list item after all.
   */
  private listBlock(): XmlElement | null {
    const first = listMarker(this.lines[this.at]!);
    if (!first) return null;
    const depth = first.pad;
    const ordered = first.ordered;
    const items: XmlElement[] = [];

    while (this.at < this.lines.length) {
      const line = this.lines[this.at]!;
      const marker = listMarker(line);
      if (!marker || marker.pad < depth || marker.ordered !== ordered) break;
      if (marker.pad > depth) break; // a deeper list belongs to the item above; handled there

      this.at += 1;

      // Continuation lines of this item (indented plain text) join as breaks.
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

      const item = el("li", [el("p", inlineNodes(parts.join(""), this.attachmentsDir))]);

      // Nested lists: strictly deeper markers under this item.
      while (this.at < this.lines.length) {
        const nested = listMarker(this.lines[this.at]!);
        if (!nested || nested.pad <= depth) break;
        const sub = this.listBlock();
        if (!sub) break;
        item.children.push(sub);
      }
      items.push(item);
    }

    if (items.length === 0) return null;
    return el(ordered ? "ol" : "ul", items);
  }

  private tableBlock(): XmlElement | null {
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
    const [header, ...body] = rows;
    return el("table", [
      el("thead", [el("tr", header!.map((cell) => el("th", inlineNodes(cell, ""))))]),
      el("tbody", body.map((cells) => el("tr", cells.map((cell) => el("td", inlineNodes(cell, "")))))),
    ]);
  }
}

/** One list-item line: indentation depth, bullet-vs-numbered, and its text. */
function listMarker(line: string): { pad: number; ordered: boolean; text: string } | null {
  const match = /^(\s*)(- |\* |\d+\. )(.*)$/.exec(line);
  if (!match) return null;
  return {
    pad: Math.floor(match[1]!.length / 4),
    ordered: /\d/.test(match[2]!),
    text: match[3]!,
  };
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

function paragraphNode(lines: string[], attachmentsDir: string): XmlElement {
  const parts: XmlNode[] = [];
  lines.forEach((line, index) => {
    const hardBreak = line.endsWith("  ") && index < lines.length - 1;
    const content = (hardBreak ? line.slice(0, -2) : line).replace(/^[ \t]+/, "");
    parts.push(...inlineNodes(content, attachmentsDir));
    if (hardBreak) parts.push(el("br"));
  });
  return el("p", parts);
}

// ---------------------------------------------------------------------------
// Inline: markdown text → storage nodes (mirrors StorageDocument.inline)
// ---------------------------------------------------------------------------

const ESCAPABLE = new Set(["\\", "`", "*", "_", "[", "]"]);

export function escapeInline(text: string, options: { table?: boolean } = {}): string {
  let out = "";
  for (const char of text) {
    if (ESCAPABLE.has(char)) out += `\\${char}`;
    else if (options.table && char === "|") out += "\\|";
    else out += char;
  }
  // A line that would re-parse as a block marker gets that marker escaped.
  const marker = /^([#>+-]|\d+)([.)] )?/.exec(out);
  if (marker) {
    if (/^\d/.test(marker[0])) out = out.replace(/^(\d+)([.)] )/, "$1\\$2");
    else out = `\\${out}`;
  }
  return out;
}

export function unescapeInline(text: string): string {
  return text.replace(/\\(.)/g, "$1");
}

function escapeUrl(url: string): string {
  return url.replace(/[()]/g, (char) => `\\${char}`);
}

function unescapeUrl(url: string): string {
  return url.replace(/\\([()])/g, "$1");
}

function inlineNodes(text: string, attachmentsDir: string): XmlNode[] {
  const nodes: XmlNode[] = [];
  let buffer = "";
  const flush = () => {
    if (buffer) {
      nodes.push(txt(buffer));
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
        nodes.push(el("code", [txt(text.slice(i + run, close))]));
        i = close + run;
        continue;
      }
    }

    if (char === "!" && text[i + 1] === "[") {
      const link = parseLink(text, i + 1);
      if (link) {
        flush();
        nodes.push(imageNode(link.label, unescapeUrl(link.url), attachmentsDir));
        i = link.end;
        continue;
      }
    }

    if (char === "[") {
      const link = parseLink(text, i);
      if (link) {
        flush();
        nodes.push(el("a", inlineNodes(link.label, attachmentsDir), { href: unescapeUrl(link.url) }));
        i = link.end;
        continue;
      }
    }

    if (char === "*" && text[i + 1] === "*") {
      const close = text.indexOf("**", i + 2);
      if (close > i + 1) {
        flush();
        nodes.push(el("strong", inlineNodes(text.slice(i + 2, close), attachmentsDir)));
        i = close + 2;
        continue;
      }
    }

    if (char === "*" && text[i + 1] !== " " && text.indexOf("*", i + 1) > 0) {
      const close = text.indexOf("*", i + 1);
      if (close > i) {
        flush();
        nodes.push(el("em", inlineNodes(text.slice(i + 1, close), attachmentsDir)));
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

function imageNode(alt: string, url: string, attachmentsDir: string): XmlElement {
  const prefix = `${attachmentsDir}/`;
  if (url.startsWith(prefix)) {
    return el(
      "ac:image",
      [el("ri:attachment", [], { "ri:filename": url.slice(prefix.length) })],
      alt ? { "ac:alt": alt } : {},
    );
  }
  return el("ac:image", [el("ri:url", [], { "ri:value": url })], alt ? { "ac:alt": alt } : {});
}

// ---------------------------------------------------------------------------
// Construction helpers
// ---------------------------------------------------------------------------

function el(name: string, children: XmlNode[] = [], attrs: Record<string, string> = {}): XmlElement {
  return { type: "element", name, attrs, children, start: 0, end: 0 };
}

function txt(value: string): XmlNode {
  return { type: "text", value };
}
