/**
 * Converter golden cases + lossless roundtrip checks (no network, no fs).
 *
 * Each case authors a piece of Confluence storage that the product really
 * sees, asserts the Markdown snapshot, and then proves the invariant both
 * ways: storage → md → storage reproduces the original byte for byte, and
 * md → storage → md is stable.
 *
 * Run: node --test packages/daemon/test/storage-markdown.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  markdownToStorage,
  parseFrontmatter,
  storageToMarkdown,
} from "../dist/sync/storage-markdown.js";

const META = { pageId: "101", version: 3, space: "ENG", title: "회원 관리 기획서", parentPageId: null };
const DIR = "attachments/101";

function roundtrip(storage) {
  const markdown = storageToMarkdown(storage, META, DIR);
  const back = markdownToStorage(markdown, DIR).storage;
  return { markdown, back };
}

// ---------------------------------------------------------------------------
// Block shapes
// ---------------------------------------------------------------------------

test("headings, paragraphs and inline styling convert", () => {
  const storage = `<h1>회원 관리</h1><h2>목표</h2><p>이 문서는 <strong>회원 관리 화면</strong>의 기획을 담는다. <em>핵심 가치</em>는 단순함이다. <code>member.role</code> 필드가 그걸 정의한다.</p>`;
  const { markdown, back } = roundtrip(storage);
  assert.equal(
    markdown,
    `---\npageId: "101"\nversion: 3\nspace: "ENG"\ntitle: "회원 관리 기획서"\nparentPageId: null\n---\n\n# 회원 관리\n\n## 목표\n\n이 문서는 **회원 관리 화면**의 기획을 담는다. *핵심 가치*는 단순함이다. \`member.role\` 필드가 그걸 정의한다.\n`,
  );
  assert.equal(back, storage);
});

test("links, hard breaks, emoji and entities survive", () => {
  const storage = `<p><a href="https://example.com/wiki/member">회원 위키</a> 문서를 참고한다 😀</p><p>첫 줄<br/>둘째 줄</p><p>A &amp; B &lt;C&gt; 100% 완료</p>`;
  const { markdown, back } = roundtrip(storage);
  assert.match(markdown, /\[회원 위키\]\(https:\/\/example\.com\/wiki\/member\) 문서를 참고한다 😀/);
  assert.match(markdown, /첫 줄  \n둘째 줄/);
  assert.equal(back, storage);
});

test("nested lists with ordered/unordered mix round-trip", () => {
  const storage = `<ul><li><p>회원 목록</p><ul><li><p>검색</p></li><li><p>필터</p></li></ul></li><li><p>회원 상세</p></li></ul><ol><li><p>조회한다</p></li><li><p>승인한다</p></li></ol>`;
  const { markdown, back } = roundtrip(storage);
  assert.match(markdown, /- 회원 목록\n    - 검색\n    - 필터\n- 회원 상세/);
  assert.match(markdown, /1. 조회한다\n2. 승인한다/);
  assert.equal(back, storage);
});

test("a simple table converts to a markdown table", () => {
  const storage = `<table><thead><tr><th>화면</th><th>우선순위</th></tr></thead><tbody><tr><td>회원 목록</td><td>높음</td></tr><tr><td>회원 상세 | 조회</td><td>보통</td></tr></tbody></table>`;
  const { markdown, back } = roundtrip(storage);
  assert.match(markdown, /\| 화면 \| 우선순위 \|/);
  assert.match(markdown, /\| 회원 상세 \\\| 조회 \| 보통 \|/);
  assert.equal(back, storage);
});

test("the code macro keeps its language and content", () => {
  const storage = `<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">typescript</ac:parameter><ac:plain-text-body><![CDATA[const role = "admin";
if (role) {
  console.log("no backtick runs here");
}]]></ac:plain-text-body></ac:structured-macro>`;
  const { markdown, back } = roundtrip(storage);
  assert.match(markdown, /```typescript\nconst role = "admin";/);
  assert.equal(back, storage);
});

test("a code body containing a fence escalates the fence length", () => {
  const storage = `<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">markdown</ac:parameter><ac:plain-text-body><![CDATA[\`\`\`inside
fenced]]></ac:plain-text-body></ac:structured-macro>`;
  const { markdown, back } = roundtrip(storage);
  assert.match(markdown, /^````markdown\n```inside\nfenced\n````$/m);
  assert.equal(back, storage);
});

// ---------------------------------------------------------------------------
// Preserved blocks — verbatim by construction
// ---------------------------------------------------------------------------

test("a rich-body macro is preserved verbatim", () => {
  const storage = `<ac:structured-macro ac:name="info"><ac:rich-text-body><p>이 문서는 <strong>비공개</strong>입니다.</p></ac:rich-text-body></ac:structured-macro>`;
  const { markdown, back } = roundtrip(storage);
  assert.match(markdown, /```confluence\n<ac:structured-macro ac:name="info">[\s\S]*<\/ac:structured-macro>\n```/);
  assert.equal(back, storage);
});

test("merged table cells are preserved verbatim", () => {
  const storage = `<table><tbody><tr><td colspan="2">병합된 셀</td></tr><tr><td>A</td><td>B</td></tr></tbody></table>`;
  const { markdown, back } = roundtrip(storage);
  assert.match(markdown, /```confluence/);
  assert.equal(back, storage);
});

test("a headerless table is preserved verbatim", () => {
  const storage = `<table><tbody><tr><td>값</td><td>설명</td></tr></tbody></table>`;
  const { markdown, back } = roundtrip(storage);
  assert.match(markdown, /```confluence/);
  assert.equal(back, storage);
});

test("layout sections are preserved verbatim", () => {
  const storage = `<ac:layout><ac:layout-section ac:type="two_equal"><ac:layout-cell><p>왼쪽</p></ac:layout-cell><ac:layout-cell><p>오른쪽</p></ac:layout-cell></ac:layout-section></ac:layout>`;
  const { markdown, back } = roundtrip(storage);
  assert.match(markdown, /```confluence\n<ac:layout>/);
  assert.equal(back, storage);
});

test("rich page links and emoticons preserve their paragraph verbatim", () => {
  const storage = `<p>자세한 내용은 <ac:link><ri:page ri:content-title="정책"/></ac:link> 문서 <ac:emoticon ac:name="smile"/> 를 보세요.</p>`;
  const { markdown, back } = roundtrip(storage);
  assert.match(markdown, /```confluence\n<p>자세한 내용은/);
  assert.equal(back, storage);
});

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

test("attachment and external images convert with the page folder", () => {
  const storage = `<p><ac:image ac:alt="구성도"><ri:attachment ri:filename="구성도.png"/></ac:image></p><p><ac:image><ri:url ri:value="https://cdn.example.com/logo.png"/></ac:image></p>`;
  const { markdown, back } = roundtrip(storage);
  assert.match(markdown, /!\[구성도\]\(attachments\/101\/구성도\.png\)/);
  assert.match(markdown, /!\[\]\(https:\/\/cdn\.example\.com\/logo\.png\)/);
  assert.equal(back, storage);
});

test("an image from another page is preserved verbatim", () => {
  const storage = `<p><ac:image><ri:attachment ri:filename="다른문서.png" ri:page-id="999"/></ac:image></p>`;
  const { markdown, back } = roundtrip(storage);
  assert.match(markdown, /```confluence/);
  assert.equal(back, storage);
});

test("an image with layout attributes is preserved verbatim", () => {
  const storage = `<p><ac:image ac:width="400"><ri:attachment ri:filename="구성도.png"/></ac:image></p>`;
  const { markdown, back } = roundtrip(storage);
  assert.match(markdown, /```confluence/);
  assert.equal(back, storage);
});

// ---------------------------------------------------------------------------
// Edge whitespace and escaping
// ---------------------------------------------------------------------------

test("markdown metacharacters are escaped and survive the roundtrip", () => {
  const storage = `<p>*강조* 아님 [링크] 아님 1. 번호 아님 # 제목 아님 \`code\` 아님</p><p>백슬래시 \\ 도 그대로</p>`;
  const { markdown, back } = roundtrip(storage);
  assert.match(markdown, /\\\*강조\\\*/);
  // A number mid-text needs no escaping; only line-leading markers do.
  assert.match(markdown, /아님 1\. 번호 아님/);
  assert.equal(back, storage);
});

test("paragraph edge whitespace is trimmed; interior whitespace kept", () => {
  const storage = `<p>  앞뒤 공백  </p><p>안 쪽   공백</p>`;
  const { markdown, back } = roundtrip(storage);
  assert.match(markdown, /앞뒤 공백/);
  assert.equal(back, `<p>앞뒤 공백</p><p>안 쪽   공백</p>`);
});

test("horizontal rules and empty paragraphs", () => {
  const storage = `<hr/><p>내용</p><p/>`;
  const { markdown, back } = roundtrip(storage);
  assert.match(markdown, /^---$/m);
  assert.equal(back, storage);
});

// ---------------------------------------------------------------------------
// Stability and structure
// ---------------------------------------------------------------------------

test("markdown → storage → markdown is stable", () => {
  const markdown = [
    "---",
    `pageId: "101"`,
    `version: 3`,
    `space: "ENG"`,
    `title: "회원 관리 기획서"`,
    `parentPageId: null`,
    "---",
    "",
    "# 제목",
    "",
    "본문과 **강조**, `코드`, [링크](https://example.com/a\\(b\\)).",
    "",
    "- 항목 하나",
    "    - 중첩 항목",
    "- 항목 둘",
    "",
    "| A | B |",
    "| --- | --- |",
    "| 1 | 2 |",
    "",
    "```typescript",
    "const x = 1;",
    "```",
    "",
  ].join("\n");
  const { storage, meta } = markdownToStorage(markdown, DIR);
  const regenerated = storageToMarkdown(storage, meta, DIR);
  assert.equal(regenerated, markdown);
  assert.equal(parseFrontmatter(regenerated).meta.version, 3);
});

test("a whole realistic page is lossless", () => {
  const storage = [
    `<h1>회원 관리</h1>`,
    `<p><strong>목표</strong>: 회원 조회·승인 절차를 한 화면에서. 😀</p>`,
    `<ul><li><p>회원 목록</p><ul><li><p>검색</p></li><li><p>필터</p></li></ul></li><li><p>회원 상세</p></li></ul>`,
    `<table><thead><tr><th>화면</th><th>우선순위</th></tr></thead><tbody><tr><td>회원 목록</td><td>높음</td></tr><tr><td>회원 상세</td><td>보통</td></tr></tbody></table>`,
    `<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">typescript</ac:parameter><ac:plain-text-body><![CDATA[const role = "admin";]]></ac:plain-text-body></ac:structured-macro>`,
    `<p><ac:image ac:alt="구성도"><ri:attachment ri:filename="구성도.png"/></ac:image></p>`,
    `<ac:structured-macro ac:name="info"><ac:rich-text-body><p>승인 정책은 <a href="https://example.com/policy">정책 문서</a>를 따른다.</p></ac:rich-text-body></ac:structured-macro>`,
    `<table><tbody><tr><td colspan="2">과거 이력</td></tr></tbody></table>`,
    `<hr/>`,
    `<p><a href="https://example.com/members">회원 목록 링크</a> — 끝.</p>`,
  ].join("");
  const { back } = roundtrip(storage);
  assert.equal(back, storage);
});


// ---------------------------------------------------------------------------
// Line-ending + empty-cell canonicalization (F9)
// ---------------------------------------------------------------------------

test("F9a: CRLF markdown saves without a stray carriage return and stays stable", () => {
  const markdownWithCrlf = [
    "---",
    'pageId: "101"',
    "version: 3",
    'space: "ENG"',
    'title: "회원 관리 기획서"',
    "parentPageId: null",
    "---",
    "",
    "첫 줄과 둘째 줄  ",      // hard break whose line ending is CRLF
    "둘째 줄입니다.",
    "",
  ].join("\r\n");

  const once = markdownToStorage(markdownWithCrlf, DIR);
  assert.ok(!once.storage.includes("\r"), "no CR survives the save path");
  assert.ok(once.storage.includes("<br/>"), "the hard break survived as a break");

  // The canonical markdown re-emits LF only, and a second pass is stable.
  const canonical = storageToMarkdown(once.storage, META, DIR);
  assert.ok(!canonical.includes("\r"));
  const twice = markdownToStorage(canonical, DIR);
  assert.equal(twice.storage, once.storage);
});

test("F9a: storage text with CRLF parses to LF — both directions agree", () => {
  const storage = "<p>가나다\r\n라마바</p>";
  const { markdown, back } = roundtrip(storage);
  assert.ok(!markdown.includes("\r"));
  // First pass canonicalizes; from then on the roundtrip is byte-stable.
  const canonical = back.replace("<p>가나다\r\n라마바</p>", "<p>가나다\n라마바</p>");
  assert.equal(back, canonical);
  const second = (() => {
    const md = storageToMarkdown(canonical, META, DIR);
    return markdownToStorage(md, DIR).storage;
  })();
  assert.equal(second, canonical, "canonicalized once, stable forever");
});

test("F9b: an empty table cell keeps the expanded <td></td> form", () => {
  const storage =
    '<table><thead><tr><th>화면</th><th>비고</th></tr></thead><tbody><tr><td>회원 목록</td><td></td></tr></tbody></table>';
  const { markdown, back } = roundtrip(storage);
  assert.ok(markdown.includes("| 회원 목록 |  |"), "the empty cell renders as an empty column");
  assert.ok(back.includes("<td></td>"), "the expanded form survives");
  assert.ok(!back.includes("<td/>"), "never the self-closed form");
  assert.equal(back, storage);
  // md side stable too
  const again = storageToMarkdown(back, META, DIR);
  assert.equal(again, markdown);
});
