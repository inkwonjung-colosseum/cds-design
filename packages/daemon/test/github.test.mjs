/**
 * REST golden pass for 개발자에게 넘기기 (PLAN D5): the client's request shapes
 * and its state mapping are checked against the recorded fixtures in
 * fixtures/github/. The fixture transport deep-equals POST/PATCH JSON bodies,
 * so consuming the whole pair set in order is also the assertion that the
 * create call sends title/body/head/base and nothing else.
 *
 * The state mapping is the load-bearing part: 반영됨 (merged) arrives as
 * `state: "closed"` with `merged: true`, and 변경 요청 is a review verdict
 * that a later approval by the same reviewer must clear.
 *
 * Run: node --test packages/daemon/test/github.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { GitHubClient, createGitHubTransport, parseRepoSlug } from "../dist/github.js";
import { FixtureTransport, loadFixturePairs } from "../dist/rest-transport.js";
import { handoffBodyFor } from "../dist/server.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, "fixtures", "github");
const pairs = loadFixturePairs(fixtureDir);

const TOKEN = "ghp_never_in_any_message";
const REPO = { owner: "colosseumcoinckr", repo: "cds-open-design" };

const byName = (name) => {
  const pair = pairs.find((candidate) => candidate.name === name);
  assert.ok(pair, `github fixture ${name}`);
  return pair;
};

test("every fixture pair cites its endpoint", () => {
  for (const pair of pairs) {
    assert.ok(pair.name, "a human name");
    assert.match(pair.cite, /^(GET|POST|PATCH) \/repos\//, `cite for ${pair.name}`);
    assert.match(pair.request.url, /^\/repos\//, "site-relative path");
  }
});

test("the golden pass runs end to end, in order", async () => {
  const transport = new FixtureTransport(pairs);
  const client = new GitHubClient(TOKEN, transport);

  // 개발자에게 넘기기 — the create body is deep-equalled by the fixture.
  const created = await client.createPullRequest({
    ...REPO,
    head: "cds-design/cds/20260909-1",
    base: "main",
    title: "회원 관리 기획서",
    body: byName("pr-create").request.bodyJson.body,
  });
  assert.deepEqual(created, {
    number: 7,
    url: "https://github.com/colosseumcoinckr/cds-open-design/pull/7",
    title: "회원 관리 기획서",
    state: "open",
    branch: "cds-design/cds/20260909-1",
  });

  // 열림 — no review yet.
  assert.equal((await client.getPullRequest({ ...REPO, number: 7 })).state, "open");

  // 변경 요청 — the newest verdict of the one reviewer, with COMMENTED rows
  // on both sides of it that carry no verdict at all.
  assert.equal((await client.getPullRequest({ ...REPO, number: 7 })).state, "changes_requested");

  // …and the same reviewer's later approval clears it. Reviews supersede each
  // other per user; counting every CHANGES_REQUESTED ever submitted would
  // pin the tree badge to 변경 요청 for the rest of the cycle.
  assert.equal((await client.getPullRequest({ ...REPO, number: 7 })).state, "open");

  // 반영됨 — GitHub says closed + merged, and merged wins.
  assert.equal((await client.getPullRequest({ ...REPO, number: 7 })).state, "merged");

  // Closed without a merge: not 반영됨, and no reviews call is spent on it.
  assert.equal((await client.getPullRequest({ ...REPO, number: 7 })).state, "closed");

  // A later 저장 renames the standing pull request.
  const updated = await client.updatePullRequest({
    ...REPO,
    number: 7,
    title: byName("pr-update").request.bodyJson.title,
    body: byName("pr-update").request.bodyJson.body,
  });
  assert.equal(updated.title, "회원 관리 기획서 · 주문 정책 기획서");
  assert.equal(updated.state, "open");

  // 403 — the API's own message reaches the reader, the token does not.
  await assert.rejects(
    () => client.getPullRequest({ ...REPO, number: 99 }),
    (error) => {
      assert.match(error.message, /\(exit 403\)/);
      assert.match(error.message, /Resource not accessible by personal access token/);
      assert.ok(!error.message.includes(TOKEN), "the token never reaches an error message");
      return true;
    },
  );

  // The onboarding gate: permissions.push is the answer when GitHub gives one.
  assert.deepEqual(await client.verifyPullRequestAccess(REPO), { ok: true, detail: null });

  const readOnly = await client.verifyPullRequestAccess(REPO);
  assert.equal(readOnly.ok, false);
  assert.match(readOnly.detail, /쓰기 권한이 있는 계정의 토큰/);
  assert.ok(!/브랜치|커밋|푸시|PR|머지/.test(readOnly.detail), "no git vocabulary reaches the planner");

  // No permissions block: a classic token is judged by x-oauth-scopes.
  assert.equal((await client.verifyPullRequestAccess(REPO)).ok, true, "repo scope is enough");
  const missingScope = await client.verifyPullRequestAccess(REPO);
  assert.equal(missingScope.ok, false, "repo:status is not repo");
  assert.match(missingScope.detail, /repo 권한을 켜고/);

  // A fine-grained token sends no scopes header at all; absence is not a no.
  assert.deepEqual(await client.verifyPullRequestAccess(REPO), { ok: true, detail: null });

  const notFound = await client.verifyPullRequestAccess(REPO);
  assert.equal(notFound.ok, false);
  assert.match(notFound.detail, /레포에 접근할 수 없습니다/);

  assert.equal(transport.pending, 0, "every recorded pair was used");
});

test("a refused reviews call leaves the pull request 열림 instead of failing", async () => {
  // The link the planner needs is already in hand; a badge one poll behind
  // beats a status read that throws.
  const transport = new FixtureTransport([
    byName("pr-open"),
    {
      name: "reviews refused",
      cite: "GET /repos/{owner}/{repo}/pulls/{number}/reviews",
      request: {
        method: "GET",
        url: "/repos/colosseumcoinckr/cds-open-design/pulls/7/reviews?per_page=100",
      },
      response: { status: 403, json: { message: "Resource not accessible" } },
    },
  ]);
  const client = new GitHubClient(TOKEN, transport);

  assert.equal((await client.getPullRequest({ ...REPO, number: 7 })).state, "open");
});

test("an unreachable GitHub answers the onboarding gate instead of breaking it", async () => {
  // checkProject() calls this without a try/catch: a throw here would take
  // the whole onboarding list down on a machine that is merely offline.
  const client = new GitHubClient(TOKEN, {
    request: async () => {
      throw new Error("fetch failed");
    },
  });

  const access = await client.verifyPullRequestAccess(REPO);
  assert.equal(access.ok, false);
  assert.match(access.detail, /GitHub에 연결하지 못해/);
  assert.ok(!access.detail.includes(TOKEN));
});

test("a 422 names the field GitHub complained about", async () => {
  // The one failure the planner will actually hit: pressing 넘기기 twice.
  const transport = new FixtureTransport([
    {
      name: "duplicate pull request",
      cite: "POST /repos/{owner}/{repo}/pulls",
      request: { method: "POST", url: "/repos/colosseumcoinckr/cds-open-design/pulls" },
      response: {
        status: 422,
        json: {
          message: "Validation Failed",
          errors: [{ message: "A pull request already exists for colosseumcoinckr:cds-design/cds/20260909-1." }],
        },
      },
    },
  ]);
  const client = new GitHubClient(TOKEN, transport);

  await assert.rejects(
    () =>
      client.createPullRequest({
        ...REPO,
        head: "cds-design/cds/20260909-1",
        base: "main",
        title: "회원 관리 기획서",
        body: "본문",
      }),
    /개발자에게 넘기기 실패 \(exit 422\): Validation Failed — A pull request already exists/,
  );
});

test("parseRepoSlug reads every remote form the planner can paste", () => {
  const slug = { owner: "colosseumcoinckr", repo: "cds-open-design" };
  assert.deepEqual(parseRepoSlug("https://github.com/colosseumcoinckr/cds-open-design"), slug);
  assert.deepEqual(parseRepoSlug("https://github.com/colosseumcoinckr/cds-open-design.git"), slug);
  assert.deepEqual(parseRepoSlug("git@github.com:colosseumcoinckr/cds-open-design.git"), slug);
  assert.deepEqual(parseRepoSlug("ssh://git@github.com/colosseumcoinckr/cds-open-design.git"), slug);
  // authenticatedUrl() embeds the PAT as userinfo; the slug is still the slug.
  assert.deepEqual(parseRepoSlug("https://ghp_token@github.com/colosseumcoinckr/cds-open-design.git"), slug);
  assert.deepEqual(parseRepoSlug("  https://github.com/colosseumcoinckr/cds-open-design/  "), slug);

  assert.equal(parseRepoSlug("https://gitlab.com/org/repo.git"), null, "not GitHub");
  assert.equal(parseRepoSlug("https://github.enterprise.io/org/repo.git"), null, "not github.com");
  assert.equal(parseRepoSlug("https://github.com/colosseumcoinckr"), null, "no repo");
  assert.equal(parseRepoSlug(""), null);
});

test("CDS_DESIGN_GITHUB_FIXTURE picks the recorded transport", () => {
  const chosen = createGitHubTransport({ CDS_DESIGN_GITHUB_FIXTURE: fixtureDir });
  assert.ok(chosen.transport instanceof FixtureTransport);
  assert.equal(chosen.fixtureDir, fixtureDir);

  // Without it the daemon talks to the real api — a usable transport either
  // way, because the api base is a constant and needs no caller fallback.
  const live = createGitHubTransport({});
  assert.ok(live.transport, "a transport, not null");
  assert.equal(live.fixtureDir, null);

  // An unloadable directory still reports what was asked for, so a caller
  // cannot mistake a broken fixture set for "no fixtures configured".
  const broken = createGitHubTransport({ CDS_DESIGN_GITHUB_FIXTURE: join(fixtureDir, "nope") });
  assert.equal(broken.fixtureDir, join(fixtureDir, "nope"));
  assert.ok(!(broken.transport instanceof FixtureTransport));
});

// ---------------------------------------------------------------------------
// The body a developer actually reads
// ---------------------------------------------------------------------------

const page = (over) => ({
  path: "ENG/x.md",
  title: "재고 실사 목록",
  pageId: "770412",
  parentPageId: null,
  version: 1,
  modified: false,
  conflict: false,
  isNew: false,
  ...over,
});

test("the handoff body hands the developer a 기획서 they can open", () => {
  const body = handoffBodyFor(
    [{ space: "~5f1c0d9a4b2e8c3d7a06f412", pages: [page({})] }],
    "https://example.atlassian.net/",
  );

  // The whole point of the pull request: a link, not an id to go hunt with.
  assert.ok(
    body.includes(
      "[재고 실사 목록](https://example.atlassian.net/wiki/spaces/~5f1c0d9a4b2e8c3d7a06f412/pages/770412)",
    ),
    body,
  );
  // The url spells the SPACE KEY, not the mirror's folder — a personal space
  // mirrors under `_…` and that address does not exist in Confluence.
  assert.ok(!body.includes("_5f1c0d9a4b2e8c3d7a06f412"), body);
  // `pageId: <id>` survives beside the link: it is the token the daemon scans
  // this body for to badge those pages ✓ 넘김.
  assert.match(body, /\(pageId: 770412\)/);
});

test("the handoff body links nothing it cannot link", () => {
  // A draft that 게시 has never created carries a `new-…` id and no page.
  const draft = handoffBodyFor(
    [{ space: "ENG", pages: [page({ isNew: true, pageId: "new-재고실사" })] }],
    "https://example.atlassian.net",
  );
  assert.ok(!draft.includes("]("), draft);
  assert.match(draft, /아직 Confluence에 게시되지 않음 \(pageId: new-재고실사\)/);

  // No site configured: the tool has no address to build, so it invents none.
  const siteless = handoffBodyFor([{ space: "ENG", pages: [page({})] }], null);
  assert.ok(!siteless.includes("]("), siteless);
  assert.match(siteless, /- 재고 실사 목록 \(pageId: 770412\)/);
});
