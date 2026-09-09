/**
 * Minimal namespace-aware XML fragment parser + canonical serializer.
 *
 * Confluence storage is an XHTML fragment (multiple roots, namespaced
 * elements like `ac:structured-macro`, CDATA bodies). We own both directions
 * of the converter, so this parser records the source span of every element:
 * anything Markdown cannot represent is re-emitted from its original source
 * slice, verbatim, which is what makes the roundtrip lossless.
 *
 * Not a general XML implementation: no DTDs, no namespaces resolution, no
 * processing instructions beyond skipping them. Confluence emits none of
 * those inside page storage.
 */

export interface XmlElement {
  type: "element";
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** Offsets into the source string, so the original slice can be recovered. */
  start: number;
  end: number;
}

export interface XmlText {
  type: "text";
  value: string;
}

export interface XmlCdata {
  type: "cdata";
  value: string;
}

export type XmlNode = XmlElement | XmlText | XmlCdata;

const NAME = /[A-Za-z_][\w.:-]*/y;
const ATTR_NAME = /[A-Za-z_][\w.:-]*/y;

class Cursor {
  constructor(readonly source: string, public at: number = 0) {}

  eof(): boolean {
    return this.at >= this.source.length;
  }

  /** Skips whitespace; reports whether any was consumed. */
  skipWhitespace(): boolean {
    const before = this.at;
    while (this.at < this.source.length && /\s/.test(this.source[this.at]!)) this.at += 1;
    return this.at > before;
  }

  literal(text: string): boolean {
    if (this.source.startsWith(text, this.at)) {
      this.at += text.length;
      return true;
    }
    return false;
  }
}

/** Parses a storage fragment into its top-level nodes. */
export function parseXmlFragment(source: string): XmlNode[] {
  const cursor = new Cursor(source);
  const nodes: XmlNode[] = [];
  while (!cursor.eof()) {
    const node = parseNode(cursor);
    if (node) nodes.push(node);
    else if (cursor.eof()) break;
    else throw new Error(`storage XML을 해석할 수 없습니다 (위치 ${cursor.at})`);
  }
  return nodes;
}

function parseNode(cursor: Cursor): XmlNode | null {
  if (cursor.source[cursor.at] !== "<") {
    return parseText(cursor);
  }
  if (cursor.literal("<!--")) {
    const end = cursor.source.indexOf("-->", cursor.at);
    cursor.at = end < 0 ? cursor.source.length : end + 3;
    return null;
  }
  if (cursor.literal("<?")) {
    const end = cursor.source.indexOf("?>", cursor.at);
    cursor.at = end < 0 ? cursor.source.length : end + 2;
    return null;
  }
  if (cursor.literal("<![CDATA[")) {
    const end = cursor.source.indexOf("]]>", cursor.at);
    if (end < 0) throw new Error("CDATA가 닫히지 않았습니다");
    const value = cursor.source.slice(cursor.at, end);
    cursor.at = end + 3;
    return { type: "cdata", value };
  }
  return parseElement(cursor);
}

function parseText(cursor: Cursor): XmlText | null {
  const end = cursor.source.indexOf("<", cursor.at);
  const stop = end < 0 ? cursor.source.length : end;
  if (stop === cursor.at) return null;
  const raw = cursor.source.slice(cursor.at, stop);
  cursor.at = stop;
  // XML line-ending normalization (spec 2.11): CRLF and lone CR both parse
  // as LF, so storage text can never smuggle a stray CR into the markdown.
  return { type: "text", value: normalizeLineEndings(decodeEntities(raw)) };
}

function parseElement(cursor: Cursor): XmlElement | null {
  const start = cursor.at;
  if (!cursor.literal("<")) return null;
  NAME.lastIndex = cursor.at;
  const nameMatch = NAME.exec(cursor.source);
  if (!nameMatch) throw new Error(`storage XML을 해석할 수 없습니다 (위치 ${cursor.at})`);
  cursor.at = NAME.lastIndex;
  const name = nameMatch[0];

  const attrs: Record<string, string> = {};
  for (;;) {
    cursor.skipWhitespace();
    if (cursor.literal("/>")) {
      return { type: "element", name, attrs, children: [], start, end: cursor.at };
    }
    if (cursor.literal(">")) break;
    ATTR_NAME.lastIndex = cursor.at;
    const attrMatch = ATTR_NAME.exec(cursor.source);
    if (!attrMatch) throw new Error(`storage XML을 해석할 수 없습니다 (속성 위치 ${cursor.at})`);
    cursor.at = ATTR_NAME.lastIndex;
    cursor.skipWhitespace();
    let value = "";
    if (cursor.literal("=")) {
      cursor.skipWhitespace();
      const quote = cursor.source[cursor.at];
      if (quote !== '"' && quote !== "'") throw new Error(`속성 값은 따옴표로 감싸야 합니다 (위치 ${cursor.at})`);
      cursor.at += 1;
      const close = cursor.source.indexOf(quote, cursor.at);
      if (close < 0) throw new Error("속성 값이 닫히지 않았습니다");
      value = decodeEntities(cursor.source.slice(cursor.at, close));
      cursor.at = close + 1;
    }
    attrs[attrMatch[0]] = value;
  }

  const children: XmlNode[] = [];
  for (;;) {
    if (cursor.literal(`</${name}>`)) break;
    // Tolerate a stray close tag for a name we never opened (Confluence never
    // emits one; a defensive break keeps the parser from spinning).
    if (cursor.source.startsWith("</", cursor.at)) {
      const probe = new Cursor(cursor.source, cursor.at + 2);
      NAME.lastIndex = probe.at;
      const closing = NAME.exec(cursor.source)?.[0];
      if (closing && closing !== name) throw new Error(`<${name}>이(가) 닫히지 않았습니다`);
      throw new Error(`storage XML을 해석할 수 없습니다 (위치 ${cursor.at})`);
    }
    const node = parseNode(cursor);
    if (node) children.push(node);
    else if (cursor.eof()) throw new Error(`<${name}>이(가) 닫히지 않았습니다`);
  }
  return { type: "element", name, attrs, children, start, end: cursor.at };
}

// XML predefines five entities; Confluence storage freely uses the HTML ones
// (`&middot;` between 상태 words was landing in 기획서 verbatim). Numeric
// references cover the long tail; anything named but unknown stays literal.
const ENTITY = /&(?:amp|lt|gt|quot|apos|nbsp|copy|reg|trade|hellip|mdash|ndash|lsquo|rsquo|ldquo|rdquo|sbquo|bdquo|laquo|raquo|middot|bull|dagger|Dagger|deg|plusmn|minus|times|divide|frac12|frac14|frac34|sup2|sup3|micro|para|sect|permil|prime|Prime|larr|rarr|uarr|darr|harr|euro|pound|yen|cent|#\d+|#x[0-9a-fA-F]+);/g;

const NAMED_ENTITY: Record<string, string> = {
  nbsp: "\u00a0",
  copy: "\u00a9",
  reg: "\u00ae",
  trade: "\u2122",
  hellip: "\u2026",
  mdash: "\u2014",
  ndash: "\u2013",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201c",
  rdquo: "\u201d",
  sbquo: "\u201a",
  bdquo: "\u201e",
  laquo: "\u00ab",
  raquo: "\u00bb",
  middot: "\u00b7",
  bull: "\u2022",
  dagger: "\u2020",
  Dagger: "\u2021",
  deg: "\u00b0",
  plusmn: "\u00b1",
  minus: "\u2212",
  times: "\u00d7",
  divide: "\u00f7",
  frac12: "\u00bd",
  frac14: "\u00bc",
  frac34: "\u00be",
  sup2: "\u00b2",
  sup3: "\u00b3",
  micro: "\u00b5",
  para: "\u00b6",
  sect: "\u00a7",
  permil: "\u2030",
  prime: "\u2032",
  Prime: "\u2033",
  larr: "\u2190",
  rarr: "\u2192",
  uarr: "\u2191",
  darr: "\u2193",
  harr: "\u2194",
  euro: "\u20ac",
  pound: "\u00a3",
  yen: "\u00a5",
  cent: "\u00a2",
};

/** CRLF and lone CR become LF (XML 2.11), wherever text is parsed. */
function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

export function decodeEntities(text: string): string {
  return text.replace(ENTITY, (entity) => {
    switch (entity) {
      case "&amp;":
        return "&";
      case "&lt;":
        return "<";
      case "&gt;":
        return ">";
      case "&quot;":
        return '"';
      case "&apos;":
        return "'";
      default: {
        if (entity[1] !== "#") {
          return NAMED_ENTITY[entity.slice(1, -1)] ?? entity;
        }
        const code = entity[2] === "x" || entity[2] === "X"
          ? Number.parseInt(entity.slice(3, -1), 16)
          : Number.parseInt(entity.slice(2, -1), 10);
        return String.fromCodePoint(Number.isFinite(code) ? code : 0xfffd);
      }
    }
  });
}

/** Canonical escaping for text nodes: only what XML requires. */
export function encodeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Canonical escaping for attribute values. */
export function encodeAttribute(text: string): string {
  return encodeText(text).replace(/"/g, "&quot;");
}

/** Serializes nodes back to compact storage XML, no pretty-printing. */
export function serializeXml(nodes: readonly XmlNode[]): string {
  return nodes.map(serializeNode).join("");
}

function serializeNode(node: XmlNode): string {
  if (node.type === "text") return encodeText(node.value);
  if (node.type === "cdata") {
    // A literal "]]>" inside CDATA has to split the section; parsing joins
    // the pieces back through textContent.
    return `<![CDATA[${node.value.split("]]>").join("]]]]><![CDATA[")}]]>`;
  }
  const attrs = Object.entries(node.attrs)
    .map(([name, value]) => ` ${name}="${encodeAttribute(value)}"`)
    .join("");
  if (node.children.length === 0) {
    // Table cells stay expanded: `<td></td>` is the form this converter
    // emits and accepts back, so an empty cell never collapses to `<td/>`
    // and shifts the bytes of a lossless round-trip.
    if (node.name === "td" || node.name === "th") {
      return `<${node.name}${attrs}></${node.name}>`;
    }
    return `<${node.name}${attrs}/>`;
  }
  return `<${node.name}${attrs}>${serializeXml(node.children)}</${node.name}>`;
}

/** The original source slice of an element — verbatim preservation. */
export function sourceSlice(source: string, node: XmlElement): string {
  return source.slice(node.start, node.end);
}

export function isElement(node: XmlNode): node is XmlElement {
  return node.type === "element";
}

/** All text content of a node, concatenated (macro titles, alt text). */
export function textContent(nodes: readonly XmlNode[]): string {
  return nodes
    .map((node) => {
      if (node.type === "text") return node.value;
      if (node.type === "cdata") return node.value;
      return textContent(node.children);
    })
    .join("");
}
