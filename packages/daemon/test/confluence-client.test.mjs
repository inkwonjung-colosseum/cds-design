/**
 * REST golden pass: the client's request shapes and response parsing are
 * checked against the recorded fixtures in fixtures/confluence/golden/. The
 * fixture transport deep-equals PUT/POST JSON bodies, so consuming the whole
 * pair set in order is also the assertion that update sends
 * version.number = current + 1 with the exact storage payload, and that
 * uploads are multipart with the right filename and content type.
 *
 * Run: node --test packages/daemon/test/confluence-client.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ConfluenceClient, basicAuth } from "../dist/sync/confluence-client.js";
import { FixtureTransport, loadFixturePairs } from "../dist/rest-transport.js";

const here = dirname(fileURLToPath(import.meta.url));
const goldenDir = join(here, "fixtures", "confluence", "golden");
const pairs = loadFixturePairs(goldenDir);

const credentials = { siteUrl: "https://example.atlassian.net", email: "dev@example.com", apiToken: "토큰" };

test("every fixture pair cites its endpoint", () => {
  for (const pair of pairs) {
    assert.ok(pair.name, "a human name");
    assert.match(pair.cite, /\/wiki\//, `cite for ${pair.name}`);
    assert.match(pair.request.url, /^\/wiki\//, "site-relative path");
  }
});

test("basic auth is email:token, base64", () => {
  assert.equal(basicAuth(credentials), Buffer.from("dev@example.com:토큰").toString("base64"));
});

test("the golden pass runs end to end, in order", async () => {
  const transport = new FixtureTransport(pairs);
  const client = new ConfluenceClient(credentials, transport);

  // spaces
  const spaces = await client.listSpaces(100);
  assert.deepEqual(spaces, [{ id: "9001", key: "ENG", name: "엔지니어링" }]);
  assert.equal((await client.findSpace("ENG")).id, "9001");
  assert.equal((await client.findSpace("9001")).key, "ENG");
  await assert.rejects(() => client.findSpace("NOPE"), /스페이스를 찾을 수 없습니다/);

  // pages list
  const pages = await client.listSpacePages("9001");
  assert.deepEqual(
    pages.map((page) => [page.id, page.version, page.parentId]),
    [["101", 3, null], ["102", 2, "101"]],
  );

  // page get — the storage passes through unparsed; shape-check it
  const page = await client.getPage("101");
  assert.equal(page.version, 3);
  assert.match(page.storage, /^<h1>회원 관리<\/h1>/);
  assert.match(page.storage, /ri:filename="구성도\.png"/);

  const page102 = await client.getPage("102");
  assert.equal(page102.parentId, "101");
  assert.match(page102.storage, /^<h2>주문 정책<\/h2>/);

  // subtree walk — root first, then breadth-first, over two cursor pages of
  // 201's children. The children endpoint sends no version and no parentId:
  // descendants come back at version 0 (= unknown, fetch the body) under the
  // parent they were listed for, and only the root's own body carries one.
  const subtree = await client.listSubtreePages("201");
  assert.deepEqual(
    subtree.map((page) => [page.id, page.title, page.parentId, page.version]),
    [
      ["201", "회원 도메인", null, 2],
      ["202", "회원 가입", "201", 0],
      ["203", "회원 탈퇴", "201", 0],
      ["204", "가입 약관", "202", 0],
    ],
  );

  // ancestors — ids only, outermost first: 204 sits under 202 under 201.
  assert.deepEqual(await client.pageAncestors("204"), ["201", "202"]);

  // create — the fixture deep-equals the POST body (spaceId, title, storage)
  const created = await client.createPage({ spaceId: "9001", title: "새 문서", storage: "<p>새 문서</p>" });
  assert.equal(created.id, "103");
  assert.equal(created.version, 1);

  // update — the fixture deep-equals version.number = 4 = 3 + 1 and the storage
  const updated = await client.updatePage({
    pageId: "101",
    title: "회원 관리 기획서",
    baseVersion: 3,
    storage: `${page.storage}<p>원격에서 반영된 문단입니다.</p>`,
  });
  assert.equal(updated.version, 4);
  assert.equal(
    storageOf("update page (version+1 asserted)"),
    `${page.storage}<p>원격에서 반영된 문단입니다.</p>`,
    "the asserted PUT payload is exactly the converted edit",
  );

  // attachments (v1)
  const attachments = await client.listAttachments("101");
  assert.equal(attachments[0].title, "구성도.png");
  assert.equal(attachments[0].mediaType, "image/png");
  assert.equal(attachments[0].version, 2);

  const bytes = await client.downloadAttachment(attachments[0]);
  assert.equal(Buffer.from(bytes).subarray(1, 4).toString("ascii"), "PNG");

  const uploaded = await client.uploadAttachment({
    pageId: "102",
    filename: "새로운 첨부.txt",
    mediaType: "text/plain",
    content: new TextEncoder().encode("새로운 첨부 내용입니다"),
  });
  assert.equal(uploaded.title, "새로운 첨부.txt");
  assert.equal(uploaded.mediaType, "text/plain");

  assert.equal(transport.pending, 0, "every golden pair was consumed, in order");
});

/** The storage a fixture pair carries, by name. */
function storageOf(name) {
  const pair = pairs.find((candidate) => candidate.name === name);
  assert.ok(pair, `fixture ${name}`);
  return pair.request.bodyJson.body.value;
}

test("a request without a matching fixture fails loudly", async () => {
  const transport = new FixtureTransport([]);
  const client = new ConfluenceClient(credentials, transport);
  await assert.rejects(() => client.listSpaces(), /fixture에 응답이 없습니다/);
});

test("a non-200 response surfaces the body", async () => {
  const transport = new FixtureTransport([
    {
      name: "unauthorized",
      cite: "GET /wiki/api/v2/spaces",
      request: { method: "GET", url: "/wiki/api/v2/spaces?limit=100" },
      response: { status: 401, json: { message: "Unauthorized" } },
    },
  ]);
  const client = new ConfluenceClient(credentials, transport);
  await assert.rejects(() => client.listSpaces(100), /Confluence 요청 실패 \(exit 401\).*Unauthorized/);
});

test("listSpaces follows the cursor, so a space past the first page is findable", async () => {
  // A site with more spaces than one page: the planner's space sits on page 2.
  // Reading page 1 only used to hide it from the picker and make clone fail
  // with 스페이스를 찾을 수 없습니다.
  const cursorPages = () => [
    {
      name: "spaces page 1",
      cite: "GET /wiki/api/v2/spaces — cursor-paginated",
      request: { method: "GET", url: "/wiki/api/v2/spaces?limit=100" },
      response: {
        status: 200,
        json: {
          results: [{ id: "9001", key: "ENG", name: "엔지니어링" }],
          _links: { next: "/wiki/api/v2/spaces?limit=100&cursor=next" },
        },
      },
    },
    {
      name: "spaces page 2",
      cite: "GET /wiki/api/v2/spaces — cursor-paginated",
      request: { method: "GET", url: "/wiki/api/v2/spaces?limit=100&cursor=next" },
      response: {
        status: 200,
        json: { results: [{ id: "9002", key: "DESIGN", name: "디자인" }], _links: {} },
      },
    },
  ];
  // One pair set per call: listSpaces here, listSpaces again inside findSpace.
  const transport = new FixtureTransport([...cursorPages(), ...cursorPages()]);
  const client = new ConfluenceClient(credentials, transport);

  assert.deepEqual(
    (await client.listSpaces(100)).map((space) => space.key),
    ["ENG", "DESIGN"],
  );
  assert.equal((await client.findSpace("DESIGN")).id, "9002");
  assert.equal(transport.pending, 0, "both cursor pages were read, both times");
});

/**
 * Confluence lets a page be moved while a walk is in flight, and a cursor
 * can hand back a result it already gave. Either way the same id shows up
 * twice — and a subtree walk that re-queues it never returns, which would
 * hang a clone with no error to show the planner.
 */
test("a subtree walk that meets the same page twice still terminates", async () => {
  const children = (parentId, ids) => ({
    name: `children of ${parentId}`,
    cite: "GET /wiki/api/v2/pages/{id}/children",
    request: { method: "GET", url: `/wiki/api/v2/pages/${parentId}/children?limit=50` },
    response: {
      status: 200,
      json: {
        results: ids.map((id) => ({ id: String(id), status: "current", title: `페이지 ${id}`, spaceId: "9001" })),
        _links: {},
      },
    },
  });
  const transport = new FixtureTransport([
    {
      name: "root 301",
      cite: "GET /wiki/api/v2/pages/{id}?body-format=storage",
      request: { method: "GET", url: "/wiki/api/v2/pages/301?body-format=storage" },
      response: { status: 200, json: { id: "301", title: "루트", version: { number: 1 }, body: { storage: { value: "<p>루트</p>" } } } },
    },
    // 302 points back at its own parent, and lists 303 twice.
    children(301, [302]),
    children(302, [301, 303, 303]),
    children(303, []),
  ]);
  const client = new ConfluenceClient(credentials, transport);

  assert.deepEqual(
    (await client.listSubtreePages("301")).map((page) => page.id),
    ["301", "302", "303"],
    "each page once, and the walk ends",
  );
  assert.equal(transport.pending, 0, "every page was asked for its children exactly once");
});

/**
 * The ancestors call is only how 프로젝트 만들기 tells whether a chosen root
 * already sits inside another project. A site (or a token) that will not
 * answer it must not stop the planner from creating the project.
 */
test("a site that refuses the ancestors call reports no ancestors", async () => {
  const transport = new FixtureTransport([
    {
      name: "ancestors refused",
      cite: "GET /wiki/api/v2/pages/{id}/ancestors",
      request: { method: "GET", url: "/wiki/api/v2/pages/204/ancestors" },
      response: { status: 404, json: { message: "Not Found" } },
    },
  ]);
  const client = new ConfluenceClient(credentials, transport);

  assert.deepEqual(await client.pageAncestors("204"), []);
});


/**
 * A site's space list carries everyone's personal space. The picker is for
 * choosing what to mirror, and nobody mirrors a colleague's private notes —
 * but a space already mirrored must still resolve, or its pulls break.
 */
function spacePage(name) {
  return {
    name,
    cite: "GET /wiki/api/v2/spaces",
    request: { method: "GET", url: "/wiki/api/v2/spaces?limit=100" },
    response: {
      status: 200,
      json: {
        results: [
          { id: "1", key: "ENG", name: "엔지니어링", type: "global" },
          { id: "2", key: "~me-1", name: "내 개인 공간", type: "personal", authorId: "me-1" },
          { id: "3", key: "~other-9", name: "남의 개인 공간", type: "personal", authorId: "other-9" },
        ],
        _links: {},
      },
    },
  };
}

const currentUser = {
  name: "현재 사용자",
  cite: "GET /wiki/rest/api/user/current",
  request: { method: "GET", url: "/wiki/rest/api/user/current" },
  response: { status: 200, json: { accountId: "me-1" } },
};

test("the picker keeps my personal space and drops everyone else's", async () => {
  const transport = new FixtureTransport([currentUser, spacePage("공간 목록")]);
  const client = new ConfluenceClient(credentials, transport);

  assert.deepEqual(
    (await client.listSpaces()).map((space) => space.key),
    ["ENG", "~me-1"],
  );
});

test("a space the picker hides can still be looked up by key", async () => {
  const transport = new FixtureTransport([currentUser, spacePage("공간 목록")]);
  const client = new ConfluenceClient(credentials, transport);

  assert.equal((await client.findSpace("~other-9")).name, "남의 개인 공간");
});

test("a site that will not say who I am hides nothing", async () => {
  const transport = new FixtureTransport([spacePage("공간 목록")]);
  const client = new ConfluenceClient(credentials, transport);

  assert.deepEqual(
    (await client.listSpaces()).map((space) => space.key),
    ["ENG", "~me-1", "~other-9"],
  );
});