/**
 * One-off generator for the checked-in Confluence golden fixtures. Run again
 * only when a fixture story changes:
 *   node packages/daemon/test/fixtures/confluence/generate.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// ── The two pages every fixture story shares ────────────────────────────────

const STORAGE_101_V3 = [
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

const STORAGE_101_V4 = `${STORAGE_101_V3}<p>원격에서 반영된 문단입니다.</p>`;
const STORAGE_101_V5 = `${STORAGE_101_V4}<p>원격 충돌 분기 문단입니다.</p>`;
const STORAGE_102_V2 = `<h2>주문 정책</h2><p>주문은 <em>당일</em> 승인된다.</p><ol><li><p>조회한다</p></li><li><p>승인한다</p></li></ol>`;
const STORAGE_102_EDITED = `${STORAGE_102_V2}<p>추가된 문단입니다.</p>`;

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const CITE = {
  spaces: "GET /wiki/api/v2/spaces — https://developer.atlassian.com/cloud/confluence/rest/v2/intro/#spaces",
  pages: "GET /wiki/api/v2/spaces/{id}/pages — paginated page list for a space",
  page: "GET /wiki/api/v2/pages/{id}?body-format=storage — page with storage body",
  children: "GET /wiki/api/v2/pages/{id}/children — child pages, cursor-paginated (no version, no parentId)",
  ancestors: "GET /wiki/api/v2/pages/{id}/ancestors — ancestors of a page, outermost first",
  create: "POST /wiki/api/v2/pages — create page (spaceId, title, body)",
  update: "PUT /wiki/api/v2/pages/{id} — update; version.number must be current+1",
  attachments: "GET /wiki/rest/api/content/{pageId}/child/attachment — v1 attachments list",
  download: "GET {attachment._links.download}, e.g. /wiki/rest/api/content/{attId}/version/{n}/file — attachment bytes",
  upload: "POST /wiki/rest/api/content/{pageId}/child/attachment — multipart upload; same filename → new version",
};

const pageJson = (id, title, version, parentId, storage) => ({
  id: String(id),
  status: "current",
  title,
  ...(parentId ? { parentId: String(parentId) } : {}),
  spaceId: "9001",
  version: { number: version, createdAt: "2026-09-08T00:00:00.000Z" },
  body: { storage: { value: storage, representation: "storage" } },
});

const pageRef = (id, title, version, parentId) => ({
  id: String(id),
  status: "current",
  title,
  ...(parentId ? { parentId: String(parentId) } : {}),
  spaceId: "9001",
  version: { number: version },
});

const spacesResult = {
  results: [{ id: "9001", key: "ENG", name: "엔지니어링", type: "personal", status: "current" }],
};

const attachmentList = {
  results: [
    {
      id: "att101",
      type: "attachment",
      title: "구성도.png",
      status: "current",
      metadata: { mediaType: "image/png" },
      version: { number: 2 },
      _links: { download: "/wiki/rest/api/content/att101/version/2/file", webui: "/wiki/attachments/1.png" },
    },
  ],
  start: 0,
  limit: 200,
  size: 1,
};

// ── The project-root subtree (M1 projects) ──────────────────────────────────
//   201 회원 도메인
//   ├── 202 회원 가입 ── 204 가입 약관
//   └── 203 회원 탈퇴
// 101/102 live in the same space and outside this subtree: that is what a
// subtree clone must NOT mirror.

const STORAGE_201 = `<h1>회원 도메인</h1><p>회원 도메인 전체 지도.</p>`;
const STORAGE_202 = `<h2>회원 가입</h2><p>가입 절차는 <strong>2단계</strong>다.</p>`;
const STORAGE_203 = `<h2>회원 탈퇴</h2><p>탈퇴 요청은 즉시 처리한다.</p>`;
const STORAGE_204 = `<h3>가입 약관</h3><p>약관 동의 항목 목록.</p>`;
// Created under 203 after the subtree was cloned.
const STORAGE_205 = `<h3>탈퇴 유의사항</h3><p>탈퇴 전 확인 항목.</p>`;

// What the children endpoint really returns: no version, no parentId. The
// client fills the parent in from the page it asked about and leaves the
// version at 0 ("unknown"), so these refs must stay this thin.
const childRef = (id, title, position) => ({
  id: String(id),
  status: "current",
  title,
  spaceId: "9001",
  childPosition: position,
});

const childrenPair = (name, parentId, results, { cursor, next } = {}) => ({
  name,
  cite: CITE.children,
  request: {
    method: "GET",
    url: `/wiki/api/v2/pages/${parentId}/children?limit=50${cursor ? `&cursor=${cursor}` : ""}`,
  },
  response: {
    status: 200,
    json: {
      results,
      _links: next ? { next: `/wiki/api/v2/pages/${parentId}/children?limit=50&cursor=${next}` } : {},
    },
  },
});

const pagePair = (name, id, title, version, parentId, storage) => ({
  name,
  cite: CITE.page,
  request: { method: "GET", url: `/wiki/api/v2/pages/${id}?body-format=storage` },
  response: { status: 200, json: pageJson(id, title, version, parentId, storage) },
});

const noAttachmentsPair = (name, pageId) => ({
  name,
  cite: CITE.attachments,
  request: {
    method: "GET",
    url: `/wiki/rest/api/content/${pageId}/child/attachment?limit=200&expand=version`,
  },
  response: { status: 200, json: { results: [], start: 0, limit: 200, size: 0 } },
});

const spacePagesPair = (name, results) => ({
  name,
  cite: CITE.pages,
  request: { method: "GET", url: "/wiki/api/v2/spaces/9001/pages?limit=50" },
  response: { status: 200, json: { results } },
});

/**
 * Every call listSubtreePages makes, in order: the root's own body (the only
 * place a version comes from) and one children walk per page — 201's split
 * over two cursor pages, so the child cursor is covered too.
 */
const subtreeListing = (prefix) => [
  pagePair(`${prefix}: root 201 (version source)`, 201, "회원 도메인", 2, null, STORAGE_201),
  childrenPair(`${prefix}: children of 201 (page 1)`, 201, [childRef(202, "회원 가입", 0)], { next: "child2" }),
  childrenPair(`${prefix}: children of 201 (page 2)`, 201, [childRef(203, "회원 탈퇴", 1)], { cursor: "child2" }),
  childrenPair(`${prefix}: children of 202`, 202, [childRef(204, "가입 약관", 0)]),
  childrenPair(`${prefix}: children of 203 (none)`, 203, []),
  childrenPair(`${prefix}: children of 204 (none)`, 204, []),
];

const ancestorsPair = (name, pageId, ids) => ({
  name,
  cite: CITE.ancestors,
  request: { method: "GET", url: `/wiki/api/v2/pages/${pageId}/ancestors` },
  // Outermost first, the order the endpoint documents.
  response: { status: 200, json: { results: ids.map((id) => ({ id: String(id), type: "page" })) } },
});

// ── golden/: one pass through every endpoint, in client call order ─────────

const spacesPair = (name) => ({
  name,
  cite: CITE.spaces,
  request: { method: "GET", url: "/wiki/api/v2/spaces?limit=100" },
  response: { status: 200, json: spacesResult },
});

const golden = [
  // The client lists spaces once per findSpace call; the pass below calls it
  // four times (list, find by key, find by id, find a miss).
  spacesPair("spaces list"),
  spacesPair("spaces list (find by key)"),
  spacesPair("spaces list (find by id)"),
  spacesPair("spaces list (find a miss)"),
  {
    name: "pages in space",
    cite: CITE.pages,
    request: { method: "GET", url: "/wiki/api/v2/spaces/9001/pages?limit=50" },
    response: { status: 200, json: { results: [pageRef(101, "회원 관리 기획서", 3), pageRef(102, "주문 정책", 2, 101)] } },
  },
  {
    name: "page 101 with storage body",
    cite: CITE.page,
    request: { method: "GET", url: "/wiki/api/v2/pages/101?body-format=storage" },
    response: { status: 200, json: pageJson(101, "회원 관리 기획서", 3, null, STORAGE_101_V3) },
  },
  {
    name: "page 102 with storage body",
    cite: CITE.page,
    request: { method: "GET", url: "/wiki/api/v2/pages/102?body-format=storage" },
    response: { status: 200, json: pageJson(102, "주문 정책", 2, 101, STORAGE_102_V2) },
  },
  // The subtree walk and the ancestor lookup a project root needs.
  ...subtreeListing("subtree"),
  ancestorsPair("ancestors of 204", 204, [201, 202]),
  {
    name: "create page",
    cite: CITE.create,
    request: {
      method: "POST",
      url: "/wiki/api/v2/pages",
      bodyJson: {
        spaceId: "9001",
        status: "current",
        title: "새 문서",
        body: { representation: "storage", value: "<p>새 문서</p>" },
      },
    },
    response: { status: 200, json: pageJson(103, "새 문서", 1, null, "<p>새 문서</p>") },
  },
  {
    name: "update page (version+1 asserted)",
    cite: CITE.update,
    request: {
      method: "PUT",
      url: "/wiki/api/v2/pages/101",
      bodyJson: {
        id: 101,
        status: "current",
        title: "회원 관리 기획서",
        body: { representation: "storage", value: STORAGE_101_V4 },
        version: { number: 4 },
      },
    },
    response: { status: 200, json: pageJson(101, "회원 관리 기획서", 4, null, STORAGE_101_V4) },
  },
  {
    name: "attachments of page 101",
    cite: CITE.attachments,
    request: { method: "GET", url: "/wiki/rest/api/content/101/child/attachment?limit=200&expand=version" },
    response: { status: 200, json: attachmentList },
  },
  {
    name: "attachment bytes",
    cite: CITE.download,
    request: { method: "GET", url: "/wiki/rest/api/content/att101/version/2/file" },
    response: { status: 200, bodyBase64: PNG_BASE64 },
  },
  {
    name: "attachment upload (multipart asserted)",
    cite: CITE.upload,
    request: {
      method: "POST",
      url: "/wiki/rest/api/content/102/child/attachment",
      bodyContains: ['name="file"; filename="새로운 첨부.txt"', "Content-Type: text/plain", "새로운 첨부 내용입니다"],
    },
    response: {
      status: 200,
      json: {
        id: "att201",
        type: "attachment",
        title: "새로운 첨부.txt",
        status: "current",
        metadata: { mediaType: "text/plain" },
        version: { number: 1 },
        _links: { download: "/wiki/rest/api/content/att201/version/1/file" },
      },
    },
  },
];

// ── e2e/: the daemon-socket story, in strict request order ─────────────────

const e2e = [
  { name: "clone: find space", cite: CITE.spaces, request: { method: "GET", url: "/wiki/api/v2/spaces?limit=100" }, response: { status: 200, json: spacesResult } },
  { name: "clone: page list v3/v2", cite: CITE.pages, request: { method: "GET", url: "/wiki/api/v2/spaces/9001/pages?limit=50" }, response: { status: 200, json: { results: [pageRef(101, "회원 관리 기획서", 3), pageRef(102, "주문 정책", 2, 101)] } } },
  { name: "clone: page 101 v3", cite: CITE.page, request: { method: "GET", url: "/wiki/api/v2/pages/101?body-format=storage" }, response: { status: 200, json: pageJson(101, "회원 관리 기획서", 3, null, STORAGE_101_V3) } },
  { name: "clone: attachments of 101", cite: CITE.attachments, request: { method: "GET", url: "/wiki/rest/api/content/101/child/attachment?limit=200&expand=version" }, response: { status: 200, json: attachmentList } },
  { name: "clone: download 구성도.png", cite: CITE.download, request: { method: "GET", url: "/wiki/rest/api/content/att101/version/2/file" }, response: { status: 200, bodyBase64: PNG_BASE64 } },
  { name: "clone: page 102 v2", cite: CITE.page, request: { method: "GET", url: "/wiki/api/v2/pages/102?body-format=storage" }, response: { status: 200, json: pageJson(102, "주문 정책", 2, 101, STORAGE_102_V2) } },
  { name: "clone: attachments of 102 (none)", cite: CITE.attachments, request: { method: "GET", url: "/wiki/rest/api/content/102/child/attachment?limit=200&expand=version" }, response: { status: 200, json: { results: [], start: 0, limit: 200, size: 0 } } },

  { name: "pull: list shows 101 at v4", cite: CITE.pages, request: { method: "GET", url: "/wiki/api/v2/spaces/9001/pages?limit=50" }, response: { status: 200, json: { results: [pageRef(101, "회원 관리 기획서", 4), pageRef(102, "주문 정책", 2, 101)] } } },
  { name: "pull: page 101 v4", cite: CITE.page, request: { method: "GET", url: "/wiki/api/v2/pages/101?body-format=storage" }, response: { status: 200, json: pageJson(101, "회원 관리 기획서", 4, null, STORAGE_101_V4) } },
  { name: "pull: attachments of 101 again", cite: CITE.attachments, request: { method: "GET", url: "/wiki/rest/api/content/101/child/attachment?limit=200&expand=version" }, response: { status: 200, json: attachmentList } },
  { name: "pull: download 구성도.png again", cite: CITE.download, request: { method: "GET", url: "/wiki/rest/api/content/att101/version/2/file" }, response: { status: 200, bodyBase64: PNG_BASE64 } },

  { name: "push: pre-check page 102 (still v2)", cite: CITE.page, request: { method: "GET", url: "/wiki/api/v2/pages/102?body-format=storage" }, response: { status: 200, json: pageJson(102, "주문 정책", 2, 101, STORAGE_102_V2) } },
  {
    name: "push: PUT page 102 with version 3 and the edited storage",
    cite: CITE.update,
    request: {
      method: "PUT",
      url: "/wiki/api/v2/pages/102",
      bodyJson: {
        id: 102,
        status: "current",
        title: "주문 정책",
        body: { representation: "storage", value: STORAGE_102_EDITED },
        version: { number: 3 },
      },
    },
    response: { status: 200, json: pageJson(102, "주문 정책", 3, 101, STORAGE_102_EDITED) },
  },

  { name: "conflict pull: list shows 101 at v5", cite: CITE.pages, request: { method: "GET", url: "/wiki/api/v2/spaces/9001/pages?limit=50" }, response: { status: 200, json: { results: [pageRef(101, "회원 관리 기획서", 5), pageRef(102, "주문 정책", 3, 101)] } } },
  { name: "conflict pull: page 101 v5 (theirs)", cite: CITE.page, request: { method: "GET", url: "/wiki/api/v2/pages/101?body-format=storage" }, response: { status: 200, json: pageJson(101, "회원 관리 기획서", 5, null, STORAGE_101_V5) } },

  { name: "conflict push: pre-check page 101 (v5 ≠ recorded 4)", cite: CITE.page, request: { method: "GET", url: "/wiki/api/v2/pages/101?body-format=storage" }, response: { status: 200, json: pageJson(101, "회원 관리 기획서", 5, null, STORAGE_101_V5) } },

  // ── projects (M1): the 회원 도메인 subtree, cloned and then pulled ─────────
  // The clone lists the subtree, then fetches each page's body (201's twice:
  // once for the listing's version, once in the clone loop, which re-fetches
  // every body anyway). None of these pages carries an attachment.
  ...subtreeListing("subtree clone"),
  pagePair("subtree clone: page 201 body", 201, "회원 도메인", 2, null, STORAGE_201),
  noAttachmentsPair("subtree clone: attachments of 201 (none)", 201),
  pagePair("subtree clone: page 202 body", 202, "회원 가입", 1, 201, STORAGE_202),
  noAttachmentsPair("subtree clone: attachments of 202 (none)", 202),
  pagePair("subtree clone: page 203 body", 203, "회원 탈퇴", 1, 201, STORAGE_203),
  noAttachmentsPair("subtree clone: attachments of 203 (none)", 203),
  pagePair("subtree clone: page 204 body", 204, "가입 약관", 1, 202, STORAGE_204),
  noAttachmentsPair("subtree clone: attachments of 204 (none)", 204),

  // The pull takes the SPACE listing instead and narrows it to the subtree
  // locally — one request per tick, with a version per page. 101/102 are in
  // every one of these listings: they are the pages a scoped pull must drop.
  spacePagesPair("subtree pull: space list, nothing moved", [
    pageRef(101, "회원 관리 기획서", 3),
    pageRef(102, "주문 정책", 2, 101),
    pageRef(201, "회원 도메인", 2),
    pageRef(202, "회원 가입", 1, 201),
    pageRef(203, "회원 탈퇴", 1, 201),
    pageRef(204, "가입 약관", 1, 202),
  ]),
  // 205 was created under 203 in Confluence: the space listing carries it
  // with its parent, so a pull picks it up without a re-clone.
  spacePagesPair("subtree pull: space list with 205 added under 203", [
    pageRef(101, "회원 관리 기획서", 3),
    pageRef(102, "주문 정책", 2, 101),
    pageRef(201, "회원 도메인", 2),
    pageRef(202, "회원 가입", 1, 201),
    pageRef(203, "회원 탈퇴", 1, 201),
    pageRef(204, "가입 약관", 1, 202),
    pageRef(205, "탈퇴 유의사항", 1, 203),
  ]),
  pagePair("subtree pull: page 205 body", 205, "탈퇴 유의사항", 1, 203, STORAGE_205),
  noAttachmentsPair("subtree pull: attachments of 205 (none)", 205),
  // 204 was moved under 101, out of the project: it leaves the narrowed
  // listing exactly as a deleted page leaves a space listing.
  spacePagesPair("subtree pull: space list with 204 moved out", [
    pageRef(101, "회원 관리 기획서", 3),
    pageRef(102, "주문 정책", 2, 101),
    pageRef(201, "회원 도메인", 2),
    pageRef(202, "회원 가입", 1, 201),
    pageRef(203, "회원 탈퇴", 1, 201),
    pageRef(204, "가입 약관", 1, 101),
  ]),
];

// ── editor/: the planning-tab story (clone → edit/save → conflict → resolve mine → push) ──

const editor = [
  {
    name: "editor: onboarding spaces check",
    cite: CITE.spaces,
    request: { method: "GET", url: "/wiki/api/v2/spaces?limit=100" },
    response: { status: 200, json: spacesResult },
  },
  ...e2e.slice(0, 7).map((pair) => ({ ...pair, name: `editor: ${pair.name.replace("clone: ", "clone ")}` })),
  {
    name: "editor: conflict pull list (101 at v5, 102 as-is)",
    cite: CITE.pages,
    request: { method: "GET", url: "/wiki/api/v2/spaces/9001/pages?limit=50" },
    response: {
      status: 200,
      json: {
        results: [
          pageRef(101, "회원 관리 기획서", 5),
          pageRef(102, "주문 정책", 2, 101),
        ],
      },
    },
  },
  {
    name: "editor: conflict theirs (page 101 v5)",
    cite: CITE.page,
    request: { method: "GET", url: "/wiki/api/v2/pages/101?body-format=storage" },
    response: { status: 200, json: pageJson(101, "회원 관리 기획서", 5, null, STORAGE_101_V5) },
  },
  {
    name: "editor: push pre-check (101 still at v5)",
    cite: CITE.page,
    request: { method: "GET", url: "/wiki/api/v2/pages/101?body-format=storage" },
    response: { status: 200, json: pageJson(101, "회원 관리 기획서", 5, null, STORAGE_101_V5) },
  },
  {
    name: "editor: resolve-mine push PUT (version 6, our storage)",
    cite: CITE.update,
    request: {
      method: "PUT",
      url: "/wiki/api/v2/pages/101",
      bodyJson: {
        id: 101,
        status: "current",
        title: "회원 관리 기획서",
        body: {
          representation: "storage",
          value: `${STORAGE_101_V3}<p>로컬에서 고친 문단입니다.</p>`,
        },
        version: { number: 6 },
      },
    },
    response: { status: 200, json: pageJson(101, "회원 관리 기획서", 6, null, `${STORAGE_101_V3}<p>로컬에서 고친 문단입니다.</p>`) },
  },
];

for (const [name, pairs] of [
  ["golden", golden],
  ["e2e", e2e],
  ["editor", editor],
]) {
  const dir = join(here, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "fixtures.json"), `${JSON.stringify(pairs, null, 2)}\n`);
  console.log(`${name}: ${pairs.length} pairs`);
}
console.log(`storages: v3=${STORAGE_101_V3.length}B v4=${STORAGE_101_V4.length}B v5=${STORAGE_101_V5.length}B 102=${STORAGE_102_V2.length}B 102edited=${STORAGE_102_EDITED.length}B`);
