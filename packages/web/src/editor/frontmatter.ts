/**
 * Frontmatter helpers for the web side. The daemon owns the canonical form
 * (doc.save rewrites it); the editor only needs to read the title and rebuild
 * the file on save, so this stays deliberately small.
 */

export interface Frontmatter {
  pageId?: string;
  version?: number;
  space?: string;
  title?: string;
  parentPageId?: string | null;
}

export function splitFrontmatter(markdown: string): { frontmatter: Frontmatter; body: string } {
  const lines = markdown.split("\n");
  if (lines[0] !== "---") return { frontmatter: {}, body: markdown };
  const end = lines.indexOf("---", 1);
  if (end < 0) return { frontmatter: {}, body: markdown };

  const frontmatter: Frontmatter = {};
  for (const line of lines.slice(1, end)) {
    const match = /^(\w+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const value = match[2]!.trim();
    if (value === "null") continue;
    if (/^-?\d+$/.test(value)) (frontmatter as Record<string, unknown>)[match[1]!] = Number(value);
    else (frontmatter as Record<string, unknown>)[match[1]!] = unquote(value);
  }
  return { frontmatter, body: lines.slice(end + 1).join("\n").replace(/^\n+/, "") };
}

export function renderFrontmatter(markdown: string, frontmatter: Frontmatter): string {
  const lines = markdown.split("\n");
  const body = lines[0] === "---" ? lines.slice((lines.indexOf("---", 1) < 0 ? 0 : lines.indexOf("---", 1)) + 1) : lines;
  return [
    "---",
    `pageId: ${quote(frontmatter.pageId ?? "")}`,
    `version: ${frontmatter.version ?? 1}`,
    `space: ${quote(frontmatter.space ?? "")}`,
    `title: ${quote(frontmatter.title ?? "")}`,
    `parentPageId: ${frontmatter.parentPageId === undefined ? "null" : frontmatter.parentPageId === null ? "null" : quote(frontmatter.parentPageId)}`,
    "---",
    "",
    ...body,
  ].join("\n");
}

function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function unquote(value: string): string {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value;
  return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}
