/**
 * SyncEngine unit checks — offline, through the same FixtureTransport the
 * daemon e2e uses, with pair sets sliced per scenario from the e2e story.
 *
 * Covers: clone layout, pull by version, pull/push conflicts with real
 * three-way data, push's optimistic-lock PUT (deep-equal asserted by the
 * transport), page creation from a new file, attachment download and
 * replace-by-hash upload, and the background-pull deferral.
 *
 * Run: node --test packages/daemon/test/sync-engine.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfluenceClient } from "../dist/sync/confluence-client.js";
import { FixtureTransport, loadFixturePairs } from "../dist/rest-transport.js";
import { SyncEngine, bodyOf, mirrorDirName } from "../dist/sync/sync-engine.js";
import { markdownToStorage, parseFrontmatter } from "../dist/sync/storage-markdown.js";

const here = dirname(fileURLToPath(import.meta.url));
const E2E = loadFixturePairs(join(here, "fixtures", "confluence", "e2e"));
const byName = (name) => {
  const pair = E2E.find((candidate) => candidate.name === name);
  assert.ok(pair, `e2e fixture ${name}`);
  return pair;
};

const CREDENTIALS = { siteUrl: "https://example.atlassian.net", email: "dev@example.com", apiToken: "토큰" };

function workdir() {
  return mkdtempSync(join(tmpdir(), "hub-sync-"));
}

/** Engine + transport over the given pair subset, plus the requests it made. */
function engine(root, pairs) {
  const urls = [];
  const transport = new FixtureTransport(pairs);
  const counting = {
    request: async (input) => {
      urls.push(input.url);
      return transport.request(input);
    },
  };
  const client = new ConfluenceClient(CREDENTIALS, counting);
  const statuses = [];
  const sync = new SyncEngine({
    root,
    clientFactory: () => client,
    onStatus: (status) => statuses.push(status),
  });
  return { sync, transport, statuses, urls, get requests() { return urls.length; } };
}

const CLONE_PAIRS = [
  "clone: find space",
  "clone: page list v3/v2",
  "clone: page 101 v3",
  "clone: attachments of 101",
  "clone: download 구성도.png",
  "clone: page 102 v2",
  "clone: attachments of 102 (none)",
].map(byName);

// ---------------------------------------------------------------------------
// clone
// ---------------------------------------------------------------------------

test("clone writes the mirror: pages, frontmatter, attachments, state", async () => {
  const root = workdir();
  try {
    const { sync, transport } = engine(root, CLONE_PAIRS);
    const status = await sync.clone("ENG");
    assert.equal(status.phase, "idle");
    assert.equal(status.pages, 2);
    assert.match(status.detail, /복제 완료/);

    const page = join(root, "ENG", "회원 관리 기획서.md");
    assert.ok(existsSync(page), "page markdown exists");
    const meta = parseFrontmatter(readFileSync(page, "utf8")).meta;
    assert.equal(meta.pageId, "101");
    assert.equal(meta.version, 3);
    assert.equal(meta.space, "ENG");
    assert.equal(meta.parentPageId, null);

    const child = join(root, "ENG", "주문 정책.md");
    assert.equal(parseFrontmatter(readFileSync(child, "utf8")).meta.parentPageId, "101");

    const png = join(root, "ENG", "attachments", "101", "구성도.png");
    assert.ok(existsSync(png), "attachment downloaded");
    assert.equal(readFileSync(png).subarray(1, 4).toString("ascii"), "PNG");

    assert.ok(existsSync(join(root, "ENG", ".confluence-sync.json")), "sidecar state");
    assert.deepEqual(sync.spaces(), ["ENG"]);
    assert.equal(transport.pending, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clone without credentials says so in Korean", async () => {
  const root = workdir();
  try {
    const sync = new SyncEngine({ root, clientFactory: () => null, onStatus: () => undefined });
    const status = await sync.clone("ENG");
    assert.equal(status.phase, "error");
    assert.match(status.detail, /Confluence 연결 정보가 설정되지 않았습니다/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a personal space mirrors under a folder the CLI will read", () => {
  const root = workdir();
  try {
    // Personal Confluence spaces are keyed `~<accountId>`. A path component
    // starting with `~` reads as a home reference to the Claude CLI, which
    // then treats the session's own mirror as foreign and cards every Read of
    // it — the whole product, unusable on the space a planner tries first.
    assert.ok(!mirrorDirName("~ACCT").startsWith("~"));
    assert.equal(mirrorDirName("ENG"), "ENG", "an ordinary key is untouched");

    const dir = join(root, mirrorDirName("~ACCT"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "재고 실사.md"),
      ['---', 'pageId: "301"', "version: 2", 'space: "~ACCT"', 'title: "재고 실사"', "parentPageId: null", "---", "", "본문", ""].join("\n"),
    );
    writeFileSync(
      join(dir, ".confluence-sync.json"),
      JSON.stringify({
        spaceKey: "~ACCT",
        spaceId: "9",
        rootPageId: null,
        pages: { 301: { file: "재고 실사.md", version: 2, markdownHash: "x", lastSyncedMarkdown: "본문" } },
        attachments: {},
        pulledAt: 1,
      }),
    );

    const { sync } = engine(root, []);
    // The folder is not the key: what the rest of the daemon and the
    // Confluence API see has to stay the key the site gave us.
    assert.deepEqual(sync.spaces(), ["~ACCT"]);

    // A doc path's first segment is the folder, and the web hands that back as
    // the space, so both spellings have to reach the same mirror.
    for (const spelling of ["~ACCT", "_ACCT"]) {
      const pages = sync.pageList(spelling);
      assert.equal(pages.length, 1, `pageList(${spelling})`);
      assert.equal(pages[0].path, "_ACCT/재고 실사.md");
      assert.equal(pages[0].pageId, "301");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an attachment the site will not hand over does not stop the clone", async () => {
  const root = workdir();
  try {
    // A real space accumulates attachments whose blob is gone or restricted.
    // Dropping only the download pair is exactly that 404: the clone used to
    // abort on it and lose every page after the one carrying it.
    const pairs = CLONE_PAIRS.filter((pair) => pair.name !== "clone: download 구성도.png");
    const { sync } = engine(root, pairs);
    const status = await sync.clone("ENG");

    assert.equal(status.phase, "idle");
    assert.equal(status.pages, 2);
    assert.match(status.detail, /첨부 1개 건너뜀/);
    assert.match(status.detail, /구성도\.png/, "the planner is told which one");
    assert.ok(existsSync(join(root, "ENG", "주문 정책.md")), "the page after it still landed");
    assert.ok(!existsSync(join(root, "ENG", "attachments", "101", "구성도.png")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a clone cut short still registers the pages it got", async () => {
  const root = workdir();
  try {
    // Everything up to page 102's body: the transport then has no answer, the
    // same shape a 429 or a dropped connection takes mid-clone. Writing state
    // only at the end used to throw all of it away and leave a folder no
    // `.confluence-sync.json` claimed — invisible to the tree, unpullable.
    const { sync } = engine(root, CLONE_PAIRS.slice(0, 5));
    const status = await sync.clone("ENG");
    assert.equal(status.phase, "error");

    assert.deepEqual(sync.spaces(), ["ENG"], "the mirror is registered");
    const state = JSON.parse(readFileSync(join(root, "ENG", ".confluence-sync.json"), "utf8"));
    assert.deepEqual(Object.keys(state.pages), ["101"]);
    assert.equal(state.spaceId, "9001", "the space id the rest of the sync needs");
    assert.deepEqual(
      sync.pageList("ENG").map((page) => page.pageId),
      ["101"],
      "the page it did fetch is offered, not hidden",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a re-clone drops the mirror's stale pages but never a local draft", async () => {
  const root = workdir();
  try {
    const { sync } = engine(root, [...CLONE_PAIRS, ...CLONE_PAIRS]);
    await sync.clone("ENG");

    // What a half-finished earlier clone (or a renamed page) leaves behind:
    // engine-written markdown for a page the space no longer lists.
    writeFileSync(
      join(root, "ENG", "옛 이름.md"),
      '---\npageId: "999"\nversion: 1\nspace: ENG\ntitle: 옛 이름\nparentPageId: null\n---\n\n본문\n',
    );
    // And what the planner wrote themselves: a 기획서 게시 has not created yet.
    writeFileSync(join(root, "ENG", "새 기획서.md"), "---\ntitle: 새 기획서\n---\n\n초안\n");

    const status = await sync.clone("ENG");
    assert.equal(status.phase, "idle");
    assert.match(status.detail, /오래된 파일 1개 정리/);
    assert.equal(existsSync(join(root, "ENG", "옛 이름.md")), false, "stale mirror page removed");
    assert.ok(existsSync(join(root, "ENG", "새 기획서.md")), "unpublished draft kept");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// subtree scope (M1 projects): a mirror of one page tree, not a whole space
// ---------------------------------------------------------------------------

const SUBTREE_CLONE_PAIRS = [
  "clone: find space",
  "subtree clone: root 201 (version source)",
  "subtree clone: children of 201 (page 1)",
  "subtree clone: children of 201 (page 2)",
  "subtree clone: children of 202",
  "subtree clone: children of 203 (none)",
  "subtree clone: children of 204 (none)",
  "subtree clone: page 201 body",
  "subtree clone: attachments of 201 (none)",
  "subtree clone: page 202 body",
  "subtree clone: attachments of 202 (none)",
  "subtree clone: page 203 body",
  "subtree clone: attachments of 203 (none)",
  "subtree clone: page 204 body",
  "subtree clone: attachments of 204 (none)",
].map(byName);

// A pull takes ONE space listing and narrows it here; 101/102 are in every
// one of these listings on purpose — they are what a scoped pull must drop.
const SUBTREE_PULL_LIST = byName("subtree pull: space list, nothing moved");

test("a subtree clone mirrors the root's own pages and nothing else in the space", async () => {
  const root = workdir();
  try {
    const { sync, transport } = engine(root, SUBTREE_CLONE_PAIRS);
    const status = await sync.clone("ENG", "201");
    assert.equal(status.phase, "idle", status.detail ?? "");
    assert.equal(status.pages, 4);
    assert.match(status.detail, /회원 도메인 하위 복제 완료/, "the detail names the root, not the space");

    // The whole subtree, each page under the parent the children walk found
    // (the endpoint itself never says).
    assert.deepEqual(
      sync
        .pageList("ENG")
        .map((page) => [page.pageId, page.parentPageId])
        .sort((a, b) => a[0].localeCompare(b[0])),
      [["201", null], ["202", "201"], ["203", "201"], ["204", "202"]],
    );

    // 101 sits in the same space, outside the subtree. Neither the folder nor
    // the sidecar may know it — and the space page list was never even asked
    // for, or the transport would have run out of fixtures.
    assert.equal(existsSync(join(root, "ENG", "회원 관리 기획서.md")), false, "a page outside the root is not mirrored");
    const state = JSON.parse(readFileSync(join(root, "ENG", ".confluence-sync.json"), "utf8"));
    assert.deepEqual(Object.keys(state.pages).sort(), ["201", "202", "203", "204"]);
    assert.equal(state.rootPageId, "201", "the scope the next pull reads back");
    assert.equal(transport.pending, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a pull after a subtree clone stays in the subtree without being told again", async () => {
  const root = workdir();
  try {
    const cloned = engine(root, SUBTREE_CLONE_PAIRS);
    await cloned.sync.clone("ENG", "201");

    // A brand-new engine over the same folder — what a daemon restart is.
    // Nothing tells it about page 201, so the scope can only come off
    // .confluence-sync.json.
    const restarted = engine(root, [SUBTREE_PULL_LIST]);
    const status = await restarted.sync.pull("ENG");
    assert.equal(status.phase, "idle", status.detail ?? "");
    assert.match(status.detail, /페이지 4개 확인 · 0개 갱신/, "the two pages outside the root were narrowed away");

    // One listing, no per-page walk and no per-page body: a background tick
    // that GETs every page of a 200-page subtree every minute is the thing
    // this mechanism exists to avoid.
    assert.deepEqual(restarted.urls, ["/wiki/api/v2/spaces/9001/pages?limit=50"]);

    // 101/102 were listed and stayed out of the mirror.
    assert.equal(existsSync(join(root, "ENG", "회원 관리 기획서.md")), false);
    const state = JSON.parse(readFileSync(join(root, "ENG", ".confluence-sync.json"), "utf8"));
    assert.deepEqual(Object.keys(state.pages).sort(), ["201", "202", "203", "204"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a page created under the project root arrives on the next pull, no re-clone", async () => {
  const root = workdir();
  try {
    const cloned = engine(root, SUBTREE_CLONE_PAIRS);
    await cloned.sync.clone("ENG", "201");

    // 205 was created under 203 in Confluence after the clone.
    const { sync } = engine(root, [
      byName("subtree pull: space list with 205 added under 203"),
      byName("subtree pull: page 205 body"),
      byName("subtree pull: attachments of 205 (none)"),
    ]);
    const status = await sync.pull("ENG");
    assert.equal(status.phase, "idle", status.detail ?? "");
    assert.match(status.detail, /페이지 5개 확인 · 1개 갱신/);

    const added = join(root, "ENG", "탈퇴 유의사항.md");
    assert.ok(existsSync(added), "the new page landed in the mirror");
    assert.equal(parseFrontmatter(readFileSync(added, "utf8")).meta.parentPageId, "203");
    const state = JSON.parse(readFileSync(join(root, "ENG", ".confluence-sync.json"), "utf8"));
    assert.deepEqual(Object.keys(state.pages).sort(), ["201", "202", "203", "204", "205"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a page moved out of the project root is left alone, local edit and all", async () => {
  const root = workdir();
  try {
    const cloned = engine(root, SUBTREE_CLONE_PAIRS);
    await cloned.sync.clone("ENG", "201");

    // The planner has unpushed work in 204 when someone re-parents it under
    // 101 — out of the project. Leaving the subtree must mean exactly what
    // disappearing from a space means today: the engine keeps its hands off.
    const departed = join(root, "ENG", "가입 약관.md");
    writeFileSync(departed, `${readFileSync(departed, "utf8").trimEnd()}\n\n내가 고친 문단입니다.\n`);

    const { sync } = engine(root, [byName("subtree pull: space list with 204 moved out")]);
    const status = await sync.pull("ENG");
    assert.equal(status.phase, "idle", status.detail ?? "");
    assert.match(status.detail, /페이지 3개 확인 · 0개 갱신/);
    assert.deepEqual(status.conflicts, [], "a page that left is not a conflict");

    assert.ok(readFileSync(departed, "utf8").includes("내가 고친 문단입니다"), "the local edit survives");
    const state = JSON.parse(readFileSync(join(root, "ENG", ".confluence-sync.json"), "utf8"));
    assert.deepEqual(Object.keys(state.pages).sort(), ["201", "202", "203", "204"], "still tracked, still pushable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// pull
// ---------------------------------------------------------------------------

test("pull with nothing moved touches nothing", async () => {
  const root = workdir();
  try {
    // A second copy of the unchanged page list is exactly what pull consumes.
    const { sync } = engine(root, [...CLONE_PAIRS, byName("clone: page list v3/v2")]);
    await sync.clone("ENG");
    const before = readFileSync(join(root, "ENG", "회원 관리 기획서.md"), "utf8");
    const status = await sync.pull("ENG");
    assert.equal(status.phase, "idle");
    assert.match(status.detail, /0개 갱신/);
    assert.equal(readFileSync(join(root, "ENG", "회원 관리 기획서.md"), "utf8"), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pull updates a moved page and keeps its attachment", async () => {
  const root = workdir();
  try {
    const { sync } = engine(root, [
      ...CLONE_PAIRS,
      byName("pull: list shows 101 at v4"),
      byName("pull: page 101 v4"),
      byName("pull: attachments of 101 again"),
      byName("pull: download 구성도.png again"),
    ]);
    await sync.clone("ENG");
    const status = await sync.pull("ENG");
    assert.equal(status.phase, "idle");
    assert.match(status.detail, /1개 갱신/);
    const markdown = readFileSync(join(root, "ENG", "회원 관리 기획서.md"), "utf8");
    assert.equal(parseFrontmatter(markdown).meta.version, 4);
    assert.match(markdown, /원격에서 반영된 문단입니다/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pull on an unmirrored space refuses instead of guessing", async () => {
  const root = workdir();
  try {
    const { sync } = engine(root, [byName("clone: find space")]);
    const status = await sync.pull("ENG");
    assert.equal(status.phase, "error");
    assert.match(status.detail, /먼저 confluence\.sync으로 복제해 주세요/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pulledAt marks the last successful fetch, and a push does not move it", async () => {
  const root = workdir();
  try {
    const { sync } = engine(root, [
      ...CLONE_PAIRS,
      byName("clone: page list v3/v2"),
      byName("push: pre-check page 102 (still v2)"),
      byName("push: PUT page 102 with version 3 and the edited storage"),
    ]);
    const cloned = await sync.clone("ENG");
    assert.ok(cloned.pulledAt > 0, "a clone counts as the first fetch");

    // A restart reads the timestamp back off disk, not out of the cache.
    const reread = new SyncEngine({ root, clientFactory: () => null, onStatus: () => undefined });
    assert.equal(reread.status("ENG").pulledAt, cloned.pulledAt);

    await new Promise((done) => setTimeout(done, 2));
    const pulled = await sync.pull("ENG");
    assert.ok(pulled.pulledAt > cloned.pulledAt, "a pull is a fetch and moves the mark");

    const file = join(root, "ENG", "주문 정책.md");
    writeFileSync(file, `${readFileSync(file, "utf8")}\n추가된 문단입니다.\n`);
    const pushed = await sync.push("ENG");
    assert.equal(pushed.pulledAt, pulled.pulledAt, "sending our own edits is not a fetch");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// push
// ---------------------------------------------------------------------------

test("push uploads an edit with version+1 and rewrites the frontmatter", async () => {
  const root = workdir();
  try {
    const { sync, transport } = engine(root, [
      ...CLONE_PAIRS,
      byName("push: pre-check page 102 (still v2)"),
      byName("push: PUT page 102 with version 3 and the edited storage"),
    ]);
    await sync.clone("ENG");

    const file = join(root, "ENG", "주문 정책.md");
    const markdown = readFileSync(file, "utf8");
    writeFileSync(file, `${markdown}\n추가된 문단입니다.\n`);

    const status = await sync.push("ENG");
    assert.equal(status.phase, "idle");
    assert.match(status.detail, /페이지 1개 반영/);
    assert.equal(parseFrontmatter(readFileSync(file, "utf8")).meta.version, 3);
    assert.equal(transport.pending, 0, "the asserted PUT body matched the converted edit");

    // Nothing left to push: a second pass makes no requests at all.
    const again = await sync.push("ENG");
    assert.match(again.detail, /페이지 0개 반영/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("push blocks when the remote moved since the recorded version", async () => {
  const root = workdir();
  try {
    const { sync, transport } = engine(root, [
      ...CLONE_PAIRS,
      byName("conflict push: pre-check page 101 (v5 ≠ recorded 4)"),
    ]);
    await sync.clone("ENG");

    const file = join(root, "ENG", "회원 관리 기획서.md");
    const markdown = readFileSync(file, "utf8");
    writeFileSync(file, `${markdown}\n로컬에서 고친 문단입니다.\n`);

    const status = await sync.push("ENG");
    assert.equal(status.phase, "error");
    assert.match(status.detail, /충돌 1개/);

    const [conflict] = status.conflicts;
    assert.equal(conflict.pageId, "101");
    assert.equal(conflict.mine.version, 3);
    assert.equal(conflict.theirs.version, 5);
    assert.match(conflict.mine.markdown, /로컬에서 고친 문단입니다/);
    assert.match(conflict.theirs.markdown, /원격 충돌 분기 문단입니다/);
    assert.equal(conflict.base.version, 3);
    assert.equal(conflict.base.markdown, bodyOf(markdown), "base is what was last synced");
    // No PUT fixture exists for this scenario; a PUT attempt would have thrown.
    assert.equal(readFileSync(file, "utf8"), `${markdown}\n로컬에서 고친 문단입니다.\n`, "the local edit stands");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pull records a conflict instead of overwriting a local edit", async () => {
  const root = workdir();
  // The e2e story reaches this state after a push; here the same remote state
  // (101 at v5, 102 untouched) is authored inline for a clone-only setup.
  const listWith101AtV5 = {
    name: "engine: list shows 101 at v5, 102 unchanged",
    cite: "GET /wiki/api/v2/spaces/{id}/pages",
    request: { method: "GET", url: "/wiki/api/v2/spaces/9001/pages?limit=50" },
    response: {
      status: 200,
      json: {
        results: [
          { id: "101", status: "current", title: "회원 관리 기획서", spaceId: "9001", version: { number: 5 } },
          { id: "102", status: "current", title: "주문 정책", parentId: "101", spaceId: "9001", version: { number: 2 } },
        ],
      },
    },
  };
  try {
    const { sync } = engine(root, [
      ...CLONE_PAIRS,
      listWith101AtV5,
      byName("conflict pull: page 101 v5 (theirs)"),
    ]);
    await sync.clone("ENG");
    const file = join(root, "ENG", "회원 관리 기획서.md");
    const markdown = readFileSync(file, "utf8");
    writeFileSync(file, `${markdown}\n로컬에서 고친 문단입니다.\n`);

    const status = await sync.pull("ENG");
    assert.equal(status.phase, "error");
    assert.equal(status.conflicts.length, 1);
    assert.match(status.detail, /충돌 1개/);
    assert.match(readFileSync(file, "utf8"), /로컬에서 고친 문단입니다/);
    assert.ok(!readFileSync(file, "utf8").includes("원격 충돌 분기"), "theirs never landed on disk");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("push creates a page from a new markdown file", async () => {
  const root = workdir();
  try {
    const create = {
      name: "engine: create page",
      cite: "POST /wiki/api/v2/pages",
      request: {
        method: "POST",
        url: "/wiki/api/v2/pages",
        bodyJson: {
          spaceId: "9001",
          status: "current",
          title: "새 문서",
          body: { representation: "storage", value: "<p>새 문서 본문</p>" },
        },
      },
      response: {
        status: 200,
        json: {
          id: "103",
          title: "새 문서",
          parentId: null,
          version: { number: 1 },
          body: { storage: { value: "<p>새 문서 본문</p>" } },
        },
      },
    };
    const { sync } = engine(root, [...CLONE_PAIRS, create]);
    await sync.clone("ENG");

    writeFileSync(
      join(root, "ENG", "새 문서.md"),
      `---\npageId: "new"\nversion: 1\nspace: "ENG"\ntitle: "새 문서"\nparentPageId: null\n---\n\n새 문서 본문\n`,
    );
    const status = await sync.push("ENG");
    assert.match(status.detail, /페이지 1개 반영/);

    const created = readFileSync(join(root, "ENG", "새 문서.md"), "utf8");
    assert.equal(parseFrontmatter(created).meta.pageId, "103");
    assert.equal(parseFrontmatter(created).meta.version, 1);
    assert.match(created, /새 문서 본문/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a never-pushed page file shows in the tree as 신규, a headerless one does not", async () => {
  const root = workdir();
  try {
    const { sync } = engine(root, CLONE_PAIRS);
    await sync.clone("ENG");

    // What a 기획 session writes for a brand-new 기획서.
    writeFileSync(
      join(root, "ENG", "회원 등급 기획서.md"),
      `---\npageId: "new-회원등급"\nversion: 0\nspace: "ENG"\ntitle: "회원 등급 기획서"\nparentPageId: null\n---\n\n## 개요\n`,
    );
    // A stray markdown file with no frontmatter is not a page and must not be
    // offered as one — 게시 would have nothing to create it from.
    writeFileSync(join(root, "ENG", "메모.md"), "그냥 메모\n");

    const pages = sync.pageList("ENG");
    const fresh = pages.find((page) => page.pageId === "new-회원등급");
    assert.ok(fresh, "the new page is in the tree before it has ever been pushed");
    assert.equal(fresh.isNew, true);
    assert.equal(fresh.modified, true);
    assert.equal(fresh.path, "ENG/회원 등급 기획서.md");
    assert.equal(
      pages.some((page) => page.path === "ENG/메모.md"),
      false,
      "a file without a pageId is not a page",
    );
    assert.equal(
      pages.filter((page) => !page.isNew).every((page) => page.isNew === false),
      true,
      "cloned pages are never marked 신규",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// attachments
// ---------------------------------------------------------------------------

test("attachments upload by content hash and are not re-uploaded", async () => {
  const root = workdir();
  try {
    const upload = (version) => ({
      name: `engine: upload v${version}`,
      cite: "POST /wiki/rest/api/content/{pageId}/child/attachment",
      request: {
        method: "POST",
        url: "/wiki/rest/api/content/102/child/attachment",
        bodyContains: ['name="file"; filename="새로운 첨부.txt"', "Content-Type: text/plain", `내용 v${version}`],
      },
      response: {
        status: 200,
        json: {
          id: `att-${version}`,
          title: "새로운 첨부.txt",
          metadata: { mediaType: "text/plain" },
          version: { number: version },
          _links: { download: `/wiki/rest/api/content/att-${version}/version/${version}/file` },
        },
      },
    });

    const { sync, transport } = engine(root, [...CLONE_PAIRS, upload(1), upload(2)]);
    await sync.clone("ENG");

    const dir = join(root, "ENG", "attachments", "102");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "새로운 첨부.txt"), "내용 v1");

    const first = await sync.push("ENG");
    assert.match(first.detail, /첨부 1개 업로드/);

    // Same content again: no request at all (proven by the v1 fixture being
    // consumed and no third upload fixture existing).
    const again = await sync.push("ENG");
    assert.match(again.detail, /첨부 0개 업로드/);

    // Changed content: replaced via a new version of the same filename.
    writeFileSync(join(dir, "새로운 첨부.txt"), "내용 v2");
    const third = await sync.push("ENG");
    assert.match(third.detail, /첨부 1개 업로드/);
    assert.equal(transport.pending, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// deferral (turn-based exclusion, DESIGN §4.4)
// ---------------------------------------------------------------------------

test("background pull defers while a token is held, then catches up", async () => {
  const root = workdir();
  try {
    const harness = engine(root, [...CLONE_PAIRS, byName("clone: page list v3/v2")]);
    const sync = harness.sync;
    await sync.clone("ENG");
    const before = harness.requests;

    sync.startBackgroundPull("ENG", 25);
    const held = sync.acquireDeferral("편집 중");
    assert.deepEqual(sync.deferralReasons, ["편집 중"]);
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(harness.requests, before, "no request while the deferral is held");
    held.release();
    assert.deepEqual(sync.deferralReasons, []);

    // After release the next tick pulls: the list call happens (the space
    // pair was already consumed by clone, the list pair by this pull).
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.ok(harness.requests > before, "the pull resumed after release");
    sync.stopBackgroundPull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("two deferrals both have to be released", async () => {
  const root = workdir();
  try {
    const harness = engine(root, [...CLONE_PAIRS, byName("clone: page list v3/v2")]);
    const sync = harness.sync;
    await sync.clone("ENG");
    const before = harness.requests;
    const first = sync.acquireDeferral("편집기 저장 대기");
    const second = sync.acquireDeferral("Claude 턴 실행 중");
    sync.startBackgroundPull("ENG", 20);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(harness.requests, before);
    first.release();
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(harness.requests, before, "one deferral is still enough to defer");
    second.release();
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.ok(harness.requests > before);
    sync.stopBackgroundPull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// conflict resolution (doc.resolve backing)
// ---------------------------------------------------------------------------

test("resolve mine keeps the file, adopts the remote version, and stays pushable", async () => {
  const root = workdir();
  const listWith101AtV5 = {
    name: "engine: list shows 101 at v5, 102 unchanged (resolve)",
    cite: "GET /wiki/api/v2/spaces/{id}/pages",
    request: { method: "GET", url: "/wiki/api/v2/spaces/9001/pages?limit=50" },
    response: {
      status: 200,
      json: {
        results: [
          { id: "101", status: "current", title: "회원 관리 기획서", spaceId: "9001", version: { number: 5 } },
          { id: "102", status: "current", title: "주문 정책", parentId: "101", spaceId: "9001", version: { number: 2 } },
        ],
      },
    },
  };
  const pushAfterResolve = {
    name: "engine: PUT after resolving mine overwrites the remote",
    cite: "PUT /wiki/api/v2/pages/{id} — version.number = current+1",
    request: {
      method: "PUT",
      url: "/wiki/api/v2/pages/101",
      bodyJson: {
        id: 101,
        status: "current",
        title: "회원 관리 기획서",
        body: { representation: "storage", value: null }, // asserted below by content check
        version: { number: 6 },
      },
    },
    response: { status: 200, json: { id: "101", title: "회원 관리 기획서", version: { number: 6 } } },
  };
  try {
    const { sync } = engine(root, [...CLONE_PAIRS, listWith101AtV5, byName("conflict pull: page 101 v5 (theirs)")]);
    await sync.clone("ENG");
    const file = join(root, "ENG", "회원 관리 기획서.md");
    const markdown = readFileSync(file, "utf8");
    writeFileSync(file, `${markdown}\n로컬에서 고친 문단입니다.\n`);

    const conflicted = await sync.pull("ENG");
    assert.equal(conflicted.conflicts.length, 1);

    const resolved = await sync.resolveConflict("ENG", "101", "mine");
    assert.equal(resolved.version, 5);
    const after = readFileSync(file, "utf8");
    assert.match(after, /로컬에서 고친 문단입니다/);
    assert.equal(parseFrontmatter(after).meta.version, 5);
    assert.equal(sync.status("ENG").conflicts.length, 0, "the conflict cleared");

    // The resolved page still counts as locally modified (awaiting push).
    const listed = sync.pageList("ENG").find((page) => page.pageId === "101");
    assert.equal(listed?.modified, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolve theirs overwrites the file with the remote markdown", async () => {
  const root = workdir();
  const listWith101AtV5 = {
    name: "engine: list shows 101 at v5, 102 unchanged (resolve theirs)",
    cite: "GET /wiki/api/v2/spaces/{id}/pages",
    request: { method: "GET", url: "/wiki/api/v2/spaces/9001/pages?limit=50" },
    response: {
      status: 200,
      json: {
        results: [
          { id: "101", status: "current", title: "회원 관리 기획서", spaceId: "9001", version: { number: 5 } },
          { id: "102", status: "current", title: "주문 정책", parentId: "101", spaceId: "9001", version: { number: 2 } },
        ],
      },
    },
  };
  try {
    const { sync } = engine(root, [...CLONE_PAIRS, listWith101AtV5, byName("conflict pull: page 101 v5 (theirs)")]);
    await sync.clone("ENG");
    const file = join(root, "ENG", "회원 관리 기획서.md");
    writeFileSync(file, `${readFileSync(file, "utf8")}\n로컬에서 고친 문단입니다.\n`);
    await sync.pull("ENG");

    const resolved = await sync.resolveConflict("ENG", "101", "theirs");
    assert.equal(resolved.version, 5);
    const after = readFileSync(file, "utf8");
    assert.match(after, /원격 충돌 분기 문단입니다/);
    assert.ok(!after.includes("로컬에서 고친 문단입니다"), "the local edit is gone");

    // Fully synced: not modified, nothing to push.
    const listed = sync.pageList("ENG").find((page) => page.pageId === "101");
    assert.equal(listed?.modified, false);
    await assert.rejects(() => sync.resolveConflict("ENG", "101", "mine"), /해결할 충돌이 없습니다/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


// ---------------------------------------------------------------------------
// Optimistic-lock regressions (F3)
// ---------------------------------------------------------------------------

test("F3: a tampered frontmatter version cannot bypass the optimistic lock", async () => {
  const dir = workdir("hub-lock-tamper-");
  // Remote moved to v5 while our mirror recorded v4.
  const listAtV5 = {
    name: "engine: list 101 at v5 (tamper probe)",
    cite: "GET /wiki/api/v2/spaces/{id}/pages",
    request: { method: "GET", url: "/wiki/api/v2/spaces/9001/pages?limit=50" },
    response: {
      status: 200,
      json: {
        results: [
          { id: "101", status: "current", title: "회원 관리 기획서", spaceId: "9001", version: { number: 5 } },
          { id: "102", status: "current", title: "주문 정책", parentId: "101", spaceId: "9001", version: { number: 2 } },
        ],
      },
    },
  };
  const pageAtV5 = {
    name: "engine: page 101 v5 (tamper probe)",
    cite: "GET /wiki/api/v2/pages/{id}?body-format=storage",
    request: { method: "GET", url: "/wiki/api/v2/pages/101?body-format=storage" },
    response: {
      status: 200,
      json: {
        id: "101",
        title: "회원 관리 기획서",
        version: { number: 5 },
        body: { storage: { value: '<p>동료가 원격에서 올린 v5 내용입니다.</p>' } },
      },
    },
  };
  try {
    const { sync } = engine(dir, [...CLONE_PAIRS, pageAtV5]);
    await sync.clone("ENG");

    const file = join(dir, "ENG", "회원 관리 기획서.md");
    const markdown = readFileSync(file, "utf8");
    // Hand-edit the body AND tamper the frontmatter to claim the remote's v5 —
    // exactly the probe: the lock must key on engine state (clone recorded
    // v3), never on this number a hand edit invented.
    const tampered = markdown.replace(/^version: 3$/m, "version: 5");
    assert.match(tampered, /^version: 5$/m, "the tamper took");
    writeFileSync(file, `${tampered.trimEnd()}\n\n내가 고친 문단입니다.\n`);

    const status = await sync.push("ENG");
    assert.equal(status.phase, "error");
    assert.equal(status.conflicts.length, 1, "a conflict, never a silent PUT");
    const conflict = status.conflicts[0];
    assert.equal(conflict.pageId, "101");
    assert.equal(conflict.base.version, 3, "the lock is judged against the recorded state, not the tampered frontmatter");
    assert.ok(!readFileSync(file, "utf8").includes("v5 내용입니다"), "the remote edit was not pulled over ours");
    // No PUT fixture exists after pageAtV5 — a PUT attempt would have thrown
    // "fixture에 응답이 없습니다" and failed the push outright.
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("F3: when engine state matches the remote, a PUT still uses the recorded base", async () => {
  const dir = workdir("hub-lock-base-");
  try {
    const { sync, transport } = engine(dir, [
      ...CLONE_PAIRS,
      {
        name: "engine: page 101 at recorded v3 (base probe)",
        cite: "GET /wiki/api/v2/pages/{id}?body-format=storage",
        request: { method: "GET", url: "/wiki/api/v2/pages/101?body-format=storage" },
        response: {
          status: 200,
          json: {
            id: "101",
            title: "회원 관리 기획서",
            version: { number: 3 },
            body: { storage: { value: '<h1>회원 관리</h1><p>동기화된 내용.</p>' } },
          },
        },
      },
      {
        name: "engine: PUT with base 3+1 (state, not frontmatter)",
        cite: "PUT /wiki/api/v2/pages/{id}",
        request: {
          method: "PUT",
          url: "/wiki/api/v2/pages/101",
          bodyJson: {
            id: 101,
            status: "current",
            title: "회원 관리 기획서",
            body: { representation: "storage", value: null },
            version: { number: 4 },
          },
        },
        response: {
          status: 200,
          json: { id: "101", title: "회원 관리 기획서", version: { number: 4 } },
        },
      },
    ]);
    await sync.clone("ENG");

    const file = join(dir, "ENG", "회원 관리 기획서.md");
    const markdown = readFileSync(file, "utf8");
    writeFileSync(file, `${markdown.trimEnd()}\n\n추가 문단입니다.\n`);

    // The PUT fixture asserts the exact storage the converter produces for
    // the edited file — proving the base came from state (3+1=4).
    const expected = JSON.parse(
      JSON.stringify({
        id: 101,
        status: "current",
        title: "회원 관리 기획서",
        body: {
          representation: "storage",
          value: markdownToStorage(readFileSync(file, "utf8"), "attachments/101").storage,
        },
        version: { number: 4 },
      }),
    );
    const put = transport.pairs.find((pair) => pair.request.method === "PUT");
    put.request.bodyJson = expected;

    const status = await sync.push("ENG");
    assert.equal(status.phase, "idle", status.detail ?? "");
    assert.equal(transport.pending, 0, "the asserted PUT body matched version 4 = state 3 + 1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Incremental pull state (F8)
// ---------------------------------------------------------------------------

test("F8: a pull that dies mid-story leaves file and state consistent — no phantom conflict", async () => {
  const dir = workdir("hub-pull-crash-");
  try {
    // Page 102 updates cleanly; the transport then dies on page 101's GET.
    const doomedPageGet = {
      name: "engine: page 101 v4 that never arrives",
      cite: "GET /wiki/api/v2/pages/{id}?body-format=storage",
      request: { method: "GET", url: "/wiki/api/v2/pages/101?body-format=storage" },
      response: { status: 500, json: { message: "boom" } },
    };
    const { sync } = engine(dir, [...CLONE_PAIRS, doomedPageGet]);
    await sync.clone("ENG");

    // Both pages move remotely.
    const movedList = {
      name: "engine: list both moved (crash probe)",
      cite: "GET /wiki/api/v2/spaces/{id}/pages",
      request: { method: "GET", url: "/wiki/api/v2/spaces/9001/pages?limit=50" },
      response: {
        status: 200,
        json: {
          results: [
            { id: "101", status: "current", title: "회원 관리 기획서", spaceId: "9001", version: { number: 4 } },
            { id: "102", status: "current", title: "주문 정책", parentId: "101", spaceId: "9001", version: { number: 3 } },
          ],
        },
      },
    };
    // Order matters: 102's page GET must exist; 101's returns 500 mid-run.
    const page102v3 = {
      name: "engine: page 102 v3 (crash probe)",
      cite: "GET /wiki/api/v2/pages/{id}?body-format=storage",
      request: { method: "GET", url: "/wiki/api/v2/pages/102?body-format=storage" },
      response: {
        status: 200,
        json: {
          id: "102",
          title: "주문 정책",
          parentId: "101",
          version: { number: 3 },
          body: { storage: { value: "<h2>주문 정책</h2><p>원격 v3.</p>" } },
        },
      },
    };

    // List order in the fixture is [101, 102]; the engine pulls in list order,
    // so 101 dies FIRST — everything after never runs. Build the story so the
    // crash is the LAST consumed pair: list first, then 101's 500.
    const transport = new FixtureTransport([movedList, doomedPageGet, page102v3]);
    const client = new ConfluenceClient(CREDENTIALS, transport);
    const failing = new SyncEngine({
      root: dir,
      clientFactory: () => client,
      onStatus: () => undefined,
    });
    const crashed = await failing.pull("ENG");
    assert.equal(crashed.phase, "error");

    // Page 101 was never written (its GET 500'd) — but page 102 also never
    // ran. What MUST hold: whatever the state file says matches what the
    // files are, so a recovered pull cannot mistake a written file for a
    // local edit. Recover with a healthy transport that serves both pages.
    const noAttachments = (pageId) => ({
      name: `engine: no attachments for ${pageId} (recovery)`,
      cite: "GET /wiki/rest/api/content/{pageId}/child/attachment",
      request: {
        method: "GET",
        url: `/wiki/rest/api/content/${pageId}/child/attachment?limit=200&expand=version`,
      },
      response: { status: 200, json: { results: [], start: 0, limit: 200, size: 0 } },
    });
    const recovery = new FixtureTransport([
      movedList,
      pageAtV4For101(),
      noAttachments("101"),
      page102v3,
      noAttachments("102"),
    ]);
    const healthy = new SyncEngine({
      root: dir,
      clientFactory: () => new ConfluenceClient(CREDENTIALS, recovery),
      onStatus: () => undefined,
    });
    const recovered = await healthy.pull("ENG");
    assert.equal(
      recovered.conflicts.length,
      0,
      `no phantom 3-way conflict: ${JSON.stringify(recovered.conflicts.map((c) => c.pageId))}`,
    );
    assert.match(readFileSync(join(dir, "ENG", "주문 정책.md"), "utf8"), /원격 v3/);
    assert.match(readFileSync(join(dir, "ENG", "회원 관리 기획서.md"), "utf8"), /원격에서 반영된/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function pageAtV4For101() {
  return {
    name: "engine: page 101 v4 (recovery)",
    cite: "GET /wiki/api/v2/pages/{id}?body-format=storage",
    request: { method: "GET", url: "/wiki/api/v2/pages/101?body-format=storage" },
    response: {
      status: 200,
      json: {
        id: "101",
        title: "회원 관리 기획서",
        version: { number: 4 },
        body: { storage: { value: "<h1>회원 관리</h1><p>원격에서 반영된 문단입니다.</p>" } },
      },
    },
  };
}


// ---------------------------------------------------------------------------
// F8 attachment window (gen-3): the transport may also die BETWEEN a page's
// file write and its attachment download. Per-page atomicity — state persists
// before attachments — means the recovered pull lands with zero conflicts.
// ---------------------------------------------------------------------------

test("F8: an attachment-window failure also recovers without a phantom conflict", async () => {
  const dir = workdir("hub-pull-att-crash-");
  try {
    const { sync } = engine(dir, [...CLONE_PAIRS]);
    await sync.clone("ENG");

    // Remote moves page 101 to v4; the pull writes the v4 file, persists
    // state, and THEN dies on the attachment-list GET.
    const movedList101 = {
      name: "engine: list 101 at v4 (attachment-crash probe)",
      cite: "GET /wiki/api/v2/spaces/{id}/pages",
      request: { method: "GET", url: "/wiki/api/v2/spaces/9001/pages?limit=50" },
      response: {
        status: 200,
        json: {
          results: [
            { id: "101", status: "current", title: "회원 관리 기획서", spaceId: "9001", version: { number: 4 } },
            { id: "102", status: "current", title: "주문 정책", parentId: "101", spaceId: "9001", version: { number: 2 } },
          ],
        },
      },
    };
    const page101v4 = {
      name: "engine: page 101 v4 (attachment-crash probe)",
      cite: "GET /wiki/api/v2/pages/{id}?body-format=storage",
      request: { method: "GET", url: "/wiki/api/v2/pages/101?body-format=storage" },
      response: {
        status: 200,
        json: {
          id: "101",
          title: "회원 관리 기획서",
          version: { number: 4 },
          body: { storage: { value: "<h1>회원 관리</h1><p>원격 v4 내용.</p>" } },
        },
      },
    };
    const attachmentList500 = {
      name: "engine: attachment list 500 (attachment-crash probe)",
      cite: "GET /wiki/rest/api/content/{pageId}/child/attachment",
      request: {
        method: "GET",
        url: "/wiki/rest/api/content/101/child/attachment?limit=200&expand=version",
      },
      response: { status: 500, json: { message: "attachment window boom" } },
    };

    const crashedTransport = new FixtureTransport([movedList101, page101v4, attachmentList500]);
    const crashed = new SyncEngine({
      root: dir,
      clientFactory: () => new ConfluenceClient(CREDENTIALS, crashedTransport),
      onStatus: () => undefined,
    });
    const crashedStatus = await crashed.pull("ENG");
    assert.equal(crashedStatus.phase, "error", "the pull failed in the attachment window");
    // The file DID land at v4 before the crash — that is the probe's premise.
    const file = join(dir, "ENG", "회원 관리 기획서.md");
    assert.match(readFileSync(file, "utf8"), /원격 v4 내용/);
    assert.equal(parseFrontmatter(readFileSync(file, "utf8")).meta.version, 4);

    // State must already record v4 (persisted BEFORE attachments) — that is
    // exactly what the old ordering left at 3, manufacturing the conflict.
    const state = JSON.parse(readFileSync(join(dir, "ENG", ".confluence-sync.json"), "utf8"));
    assert.equal(state.pages["101"].version, 4, "state matches the file that landed");

    // A recovered pull must be clean — mine==theirs conflict would prove the
    // file/state divergence the finding describes.
    const noAttachments = () => ({
      name: "engine: no attachments (recovery, attachment probe)",
      cite: "GET /wiki/rest/api/content/{pageId}/child/attachment",
      request: {
        method: "GET",
        url: "/wiki/rest/api/content/101/child/attachment?limit=200&expand=version",
      },
      response: { status: 200, json: { results: [], start: 0, limit: 200, size: 0 } },
    });
    const recovery = new FixtureTransport([movedList101, noAttachments()]);
    const healthy = new SyncEngine({
      root: dir,
      clientFactory: () => new ConfluenceClient(CREDENTIALS, recovery),
      onStatus: () => undefined,
    });
    const recovered = await healthy.pull("ENG");
    assert.equal(
      recovered.conflicts.length,
      0,
      `phantom conflict after attachment-window crash: ${JSON.stringify(
        recovered.conflicts.map((c) => ({ pageId: c.pageId, mine: c.mine.version, theirs: c.theirs.version, base: c.base.version })),
      )}`,
    );
    assert.match(recovered.detail ?? "", /0개 갱신/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// legacy folder reconciliation + 게시 review
// ---------------------------------------------------------------------------

test("a legacy raw-~ folder merges into the canonical one instead of listing twice", () => {
  const root = workdir();
  try {
    // A mirror from before the `_key` convention could hold BOTH spellings for
    // one space; the tree then listed the same space twice with two sync
    // states drifting apart. The canonical folder adopts what only the legacy
    // folder had, and the legacy folder leaves the listing — never deleted.
    const canonical = join(root, "_ACCT");
    const legacy = join(root, "~ACCT");
    mkdirSync(canonical, { recursive: true });
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(canonical, "재고 실사.md"), ['---', 'pageId: "301"', "version: 2", 'space: "~ACCT"', 'title: "재고 실사"', "parentPageId: null", "---", "", "본문", ""].join("\n"));
    writeFileSync(join(canonical, ".confluence-sync.json"), JSON.stringify({
      spaceKey: "~ACCT", spaceId: "9", rootPageId: null, pulledAt: 2, attachments: {},
      pages: { 301: { file: "재고 실사.md", version: 2, markdownHash: "x", lastSyncedMarkdown: "본문" } },
    }));
    writeFileSync(join(legacy, "이전 기획.md"), ['---', 'pageId: "302"', "version: 1", 'space: "~ACCT"', 'title: "이전 기획"', "parentPageId: null", "---", "", "옛 본문", ""].join("\n"));
    writeFileSync(join(legacy, ".confluence-sync.json"), JSON.stringify({
      spaceKey: "~ACCT", spaceId: "9", rootPageId: null, pulledAt: 1, attachments: {},
      pages: {
        301: { file: "재고 실사.md", version: 1, markdownHash: "y", lastSyncedMarkdown: "본문" },
        302: { file: "이전 기획.md", version: 1, markdownHash: "z", lastSyncedMarkdown: "옛 본문" },
      },
    }));

    const { sync } = engine(root, []);
    assert.deepEqual(sync.spaces(), ["~ACCT"], "the same space must list once");
    assert.ok(!existsSync(legacy), "the legacy folder leaves the listing");
    assert.equal(existsSync(join(root, "_ACCT", "이전 기획.md")), true, "its unique page is adopted");
    const state = JSON.parse(readFileSync(join(root, "_ACCT", ".confluence-sync.json"), "utf8"));
    assert.equal(state.pages["301"].version, 2, "the canonical record wins");
    assert.equal(state.pages["302"].file, "이전 기획.md", "the legacy-only page joins the state");

    const pages = sync.pageList("~ACCT");
    assert.equal(pages.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review reports what a push would send without touching anything", () => {
  const root = workdir();
  try {
    const dir = join(root, "_ACCT");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "재고 실사.md"), ['---', 'pageId: "301"', "version: 2", 'space: "~ACCT"', 'title: "재고 실사"', "parentPageId: null", "---", "", "새 본문", ""].join("\n"));
    writeFileSync(join(dir, "신규 기획.md"), ['---', 'pageId: "new-1"', "version: 0", 'space: "~ACCT"', 'title: "신규 기획"', "parentPageId: null", "---", "", "첫 본문", ""].join("\n"));
    writeFileSync(join(dir, ".confluence-sync.json"), JSON.stringify({
      spaceKey: "~ACCT", spaceId: "9", rootPageId: null, pulledAt: 1, attachments: {},
      pages: { 301: { file: "재고 실사.md", version: 2, markdownHash: "x", lastSyncedMarkdown: "이전 본문" } },
    }));

    const { sync, requests } = engine(root, []);
    const review = sync.review("~ACCT");
    assert.equal(requests, 0, "a review is a local read, never a Confluence call");
    assert.equal(review.pages.length, 2);

    const edited = review.pages.find((page) => page.pageId === "301");
    assert.equal(edited.isNew, false);
    assert.equal(edited.version, 2);
    assert.equal(edited.nextVersion, 3, "push sends version + 1");
    assert.ok(edited.diff.includes("-이전 본문"), "the old line shows as removed");
    assert.ok(edited.diff.includes("+새 본문"), "the new line shows as added");

    const fresh = review.pages.find((page) => page.pageId === "new-1");
    assert.equal(fresh.isNew, true);
    assert.equal(fresh.version, 0);
    assert.equal(fresh.nextVersion, 1, "게시 creates the page at v1");
    assert.ok(fresh.diff.includes("+첫 본문"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
