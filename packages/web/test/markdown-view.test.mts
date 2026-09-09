/**
 * The editor's markdown ↔ ProseMirror grammar, as pure data.
 *
 * Every keystroke in the WYSIWYG editor serializes the WHOLE body back
 * through this module, so a construct it re-parses wrongly rewrites parts of
 * the page nobody touched. Preserved ` ```confluence ` blocks are where that
 * matters most: they carry the Confluence macros Markdown cannot hold, and
 * the mirror's whole promise is that they survive a round trip byte for byte.
 *
 * Run: node --experimental-transform-types --test packages/web/test/markdown-view.test.mts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { docToMarkdown, markdownToDoc, type PMNode } from "../src/editor/markdown-view.ts";

const roundTrip = (body: string): string => docToMarkdown(markdownToDoc(body), new Map());

const MACRO_PAGE = [
  "# 회원 관리",
  "",
  "**목표**: 회원 조회·승인 절차를 한 화면에서.",
  "",
  "```typescript",
  'const role = "admin";',
  "```",
  "",
  "```confluence",
  '<ac:structured-macro ac:name="info"><ac:rich-text-body><p>승인 정책은 <a href="https://example.com/policy">정책 문서</a>를 따른다.</p></ac:rich-text-body></ac:structured-macro>',
  "```",
  "",
  "```confluence",
  '<table><tbody><tr><td colspan="2">과거 이력</td></tr></tbody></table>',
  "```",
  "",
].join("\n");

test("a fenced block keeps its own delimiter out of its content", () => {
  const doc = markdownToDoc("```typescript\nconst role = \"admin\";\n```\n");
  const [block] = doc.content ?? [];

  assert.equal(block?.type, "codeBlock");
  assert.equal(block?.attrs?.language, "typescript");
  assert.equal(
    (block?.content ?? []).map((child: PMNode) => child.text ?? "").join(""),
    'const role = "admin";',
    "the opening ```typescript line is a delimiter, not code",
  );
});

test("a page of macros survives the editor round trip byte for byte", () => {
  assert.equal(roundTrip(MACRO_PAGE), MACRO_PAGE);
  // Serializing what we just serialized has to be a no-op too: the editor
  // saves on every keystroke, so any drift compounds.
  assert.equal(roundTrip(roundTrip(MACRO_PAGE)), MACRO_PAGE);
});

test("a preserved block reaches the editor as one atom holding only its xml", () => {
  const xml = '<ac:structured-macro ac:name="info"/>';
  const doc = markdownToDoc("문단\n\n```confluence\n" + xml + "\n```\n");
  const atom = (doc.content ?? []).find((node: PMNode) => node.type === "confluenceBlock");

  assert.ok(atom, "the fence became an atomic node");
  assert.equal(atom.attrs?.xml, xml);
});

test("a fence nested inside a longer fence stays nested", () => {
  const nested = "````markdown\n```js\nx\n```\n````\n";
  assert.equal(roundTrip(nested), nested);
});

test("an unterminated fence takes the rest of the body and nothing more", () => {
  const doc = markdownToDoc("문단\n\n```confluence\n<ac:x/>");
  const atom = (doc.content ?? []).find((node: PMNode) => node.type === "confluenceBlock");

  assert.equal(atom?.attrs?.xml, "<ac:x/>");
});
