/**
 * Confluence sync end-to-end check, fully offline: the daemon's client is
 * pointed at the recorded fixtures in fixtures/confluence/e2e/ via
 * CDS_DESIGN_CONFLUENCE_FIXTURE, and every step drives the real DaemonServer
 * over the same WebSocket the browser uses.
 *
 * Story: credentials are set (token presence only comes back), a space
 * clones into the mirror with frontmatter and attachments, a pull updates a
 * moved page, a push uploads an edit with version+1 (the fixture deep-equals
 * the PUT body), and a page that moved on both sides becomes a conflict in
 * the status payload — with the local edit still on disk and no PUT sent.
 *
 * Usage: node packages/daemon/test/sync-e2e.mjs
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { WebSocket } from "ws";
import { DaemonServer } from "../dist/server.js";
import { freePort } from "./fixture-repo.mjs";
import { parseFrontmatter } from "../dist/sync/storage-markdown.js";

const here = dirname(fileURLToPath(import.meta.url));
const DIR = join(tmpdir(), "cds-design-sync-e2e");
const ROOT = join(DIR, "mirror");
// The mirror belongs to a project now, and a project has a repo root too. An
// empty scratch directory is enough: migration turns a pointed-at repo dir into
// the single `default` project, and `paths()` hands that project exactly these
// two directories back — nothing is cloned into it here.
const REPO_ROOT = join(DIR, "work");
const FIXTURES = join(here, "fixtures", "confluence", "e2e");
const API_TOKEN = "confluence_api_token_e2e";

process.env.CDS_DESIGN_CONFLUENCE_DIR = ROOT;
process.env.CDS_DESIGN_CONFLUENCE_SETTINGS = join(DIR, "settings.json");
process.env.CDS_DESIGN_CONFLUENCE_FIXTURE = FIXTURES;
// Every path the registry consults must land in the temp dir. Left on the
// defaults the daemon writes ~/cds-design/config/projects.json on the
// developer's own machine, reads the developer's own repo.json url into the
// migrated project — and then warm-starts a clone of that real remote.
process.env.CDS_DESIGN_REPO_DIR = REPO_ROOT;
process.env.CDS_DESIGN_REPO_SETTINGS = join(DIR, "repo.json");
process.env.CDS_DESIGN_PROJECTS_SETTINGS = join(DIR, "projects.json");
process.env.CDS_DESIGN_PROJECTS_DIR = join(DIR, "projects");
process.env.CDS_DESIGN_CREDENTIAL_STORE = "memory";

const results = [];
function check(name, passed, detail = "") {
  if (typeof passed !== "boolean") {
    throw new Error(`check("${name}") was called without a verdict`);
  }
  results.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

async function waitFor(predicate, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const hit = predicate();
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function main() {
  rmSync(DIR, { recursive: true, force: true });
  // The repo root has to exist before the daemon loads the registry: that is
  // what migration reads to know this install owns one project.
  mkdirSync(REPO_ROOT, { recursive: true });

  const port = await freePort();
  const server = new DaemonServer({ host: "127.0.0.1", port, token: "sync-e2e" });
  await server.start();

  const ws = new WebSocket(`ws://127.0.0.1:${port}?token=sync-e2e`);
  const inbox = [];
  ws.on("message", (raw) => inbox.push(JSON.parse(String(raw))));
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });

  const request = async (message, timeoutMs = 60_000) => {
    ws.send(JSON.stringify(message));
    const reply = await waitFor(() => inbox.find((m) => m.id === message.id), timeoutMs, message.type);
    if (reply.type === "ok") return reply.data;
    throw new Error(`${message.type} failed: ${reply.message}`);
  };

  try {
    // --- 1. before anything: unconfigured, empty ---------------------------
    const empty = await request({ id: "1", type: "confluence.status" });
    check(
      "confluence.status starts unconfigured with no spaces",
      empty.settings.apiTokenConfigured === false && empty.spaces.length === 0,
      JSON.stringify(empty.settings),
    );

    // --- 2. credentials: persisted, presence-only over the wire -----------
    const updated = await request({
      id: "2",
      type: "confluence.update",
      siteUrl: "https://example.atlassian.net",
      email: "dev@example.com",
      apiToken: API_TOKEN,
    });
    check(
      "confluence.update answers with token presence, never the value",
      updated.siteUrl === "https://example.atlassian.net" && updated.apiTokenConfigured === true,
      JSON.stringify(updated),
    );
    check(
      "the token never crosses the wire back",
      !JSON.stringify(inbox).includes(API_TOKEN),
      `${inbox.length} messages inspected`,
    );
    check(
      "the token lives in the credential store, not the settings file",
      !readFileSync(join(DIR, "settings.json"), "utf8").includes(API_TOKEN),
    );

    // --- 3. unconfigured operations refuse in Korean -----------------------
    rmSync(join(DIR, "settings.json"));
    const refused = await request({ id: "3", type: "confluence.sync", space: "ENG" }).catch((e) => e);
    await request({
      id: "4",
      type: "confluence.update",
      siteUrl: "https://example.atlassian.net",
      email: "dev@example.com",
      apiToken: API_TOKEN,
    });
    check(
      "sync without credentials refuses in Korean",
      refused.phase === "error" && /Confluence 연결 정보가 설정되지 않았습니다/.test(refused.detail ?? ""),
      refused.detail ?? "",
    );

    // --- 4. the full clone -----------------------------------------------
    const cloned = await request({ id: "5", type: "confluence.sync", space: "ENG" });
    check("clone settles idle with both pages", cloned.phase === "idle" && cloned.pages === 2, cloned.detail ?? "");
    check(
      "clone progress was broadcast on confluence.status",
      inbox.some((m) => m.type === "confluence.status" && m.status.phase === "cloning"),
    );

    const page = join(ROOT, "ENG", "회원 관리 기획서.md");
    const meta = parseFrontmatter(readFileSync(page, "utf8")).meta;
    check(
      "the page mirror carries real frontmatter",
      meta.pageId === "101" && meta.version === 3 && meta.space === "ENG" && meta.parentPageId === null,
      JSON.stringify(meta),
    );
    check(
      "the markdown keeps the preserved blocks and the attachment link",
      readFileSync(page, "utf8").includes("```confluence") &&
        readFileSync(page, "utf8").includes("](attachments/101/구성도.png)"),
    );
    const png = join(ROOT, "ENG", "attachments", "101", "구성도.png");
    check(
      "the attachment was downloaded",
      existsSync(png) && readFileSync(png).subarray(1, 4).toString("ascii") === "PNG",
    );

    // --- 5. pull updates the moved page ----------------------------------
    const pulled = await request({ id: "6", type: "confluence.pull", space: "ENG" });
    check("pull reports the update", pulled.phase === "idle" && /1개 갱신/.test(pulled.detail ?? ""), pulled.detail ?? "");
    check(
      "the pulled page is at the remote version",
      parseFrontmatter(readFileSync(page, "utf8")).meta.version === 4 &&
        readFileSync(page, "utf8").includes("원격에서 반영된 문단입니다"),
    );

    // --- 6. push uploads an edit with version+1 --------------------------
    const child = join(ROOT, "ENG", "주문 정책.md");
    writeFileSync(child, `${readFileSync(child, "utf8")}\n추가된 문단입니다.\n`);
    const pushed = await request({ id: "7", type: "confluence.push", space: "ENG" });
    check(
      "push settles idle with one page reflected",
      pushed.phase === "idle" && /페이지 1개 반영/.test(pushed.detail ?? ""),
      pushed.detail ?? "",
    );
    check(
      "the pushed file carries the new version (the PUT body was fixture-asserted)",
      parseFrontmatter(readFileSync(child, "utf8")).meta.version === 3,
    );

    // --- 7. a page moved on both sides becomes a conflict ----------------
    writeFileSync(page, `${readFileSync(page, "utf8")}\n로컬에서 고친 문단입니다.\n`);
    const conflictPull = await request({ id: "8", type: "confluence.pull", space: "ENG" });
    check(
      "pull surfaces the conflict instead of overwriting",
      conflictPull.phase === "error" && conflictPull.conflicts.length === 1,
      `${conflictPull.phase}: ${conflictPull.detail}`,
    );
    const conflict = conflictPull.conflicts[0];
    check(
      "the conflict carries three-way data",
      conflict.pageId === "101" &&
        conflict.mine.version === 4 &&
        conflict.theirs.version === 5 &&
        conflict.base.version === 4 &&
        conflict.mine.markdown.includes("로컬에서 고친 문단입니다") &&
        conflict.theirs.markdown.includes("원격 충돌 분기 문단입니다"),
      `mine v${conflict.mine.version} · theirs v${conflict.theirs.version} · base v${conflict.base.version}`,
    );
    check(
      "the local edit survives the conflict",
      readFileSync(page, "utf8").includes("로컬에서 고친 문단입니다") &&
        !readFileSync(page, "utf8").includes("원격 충돌 분기"),
    );

    const conflictPush = await request({ id: "9", type: "confluence.push", space: "ENG" });
    check(
      "push is blocked by the same conflict",
      conflictPush.phase === "error" && conflictPush.conflicts.length === 1 && /충돌 1개/.test(conflictPush.detail ?? ""),
      conflictPush.detail ?? "",
    );

    const listed = await request({ id: "10", type: "confluence.status" });
    check(
      "confluence.status carries the space, its pages and the conflict",
      listed.spaces.length === 1 &&
        listed.spaces[0].space === "ENG" &&
        listed.spaces[0].pages === 2 &&
        listed.spaces[0].conflicts.length === 1,
      JSON.stringify(listed.spaces.map((s) => [s.space, s.phase, s.pages, s.conflicts.length])),
    );

    // --- 8. a write from outside the editor is normalized in place -------
    //
    // This is the 기획 session's own path: Claude edits a page file with its
    // own tools, and the mirror still has to end up in the one canonical
    // shape doc.save produces — otherwise the modified marker, the editor and
    // the push body disagree about the same page.
    const fresh = join(ROOT, "ENG", "회원 등급 기획서.md");
    const authored =
      `---\npageId: "new-회원등급"\nversion: 0\nspace: "ENG"\ntitle: "회원 등급 기획서"\n` +
      `parentPageId: null\n---\n\n## 개요\n\n*  등급은 4단계다.\n`;
    inbox.length = 0;
    writeFileSync(fresh, authored);

    const changed = await waitFor(
      () => inbox.find((m) => m.type === "doc.changed" && m.path.endsWith("회원 등급 기획서.md")),
      10_000,
      "doc.changed for the authored page",
    );
    check("an outside write is broadcast to the editor", Boolean(changed));

    const normalized = readFileSync(fresh, "utf8");
    check(
      "the daemon rewrote it in canonical form",
      normalized !== authored && normalized.includes("-  등급은 4단계다."),
      JSON.stringify(normalized.slice(-30)),
    );

    // Rewriting the canonical form must produce no second rewrite, or the
    // watcher would feed itself forever.
    inbox.length = 0;
    writeFileSync(fresh, normalized);
    await waitFor(
      () => inbox.find((m) => m.type === "doc.changed" && m.path.endsWith("회원 등급 기획서.md")),
      10_000,
      "doc.changed for the canonical rewrite",
    );
    await new Promise((resolve) => setTimeout(resolve, 400));
    check(
      "canonical content is left alone (no watcher loop)",
      readFileSync(fresh, "utf8") === normalized &&
        inbox.filter((m) => m.type === "doc.changed").length === 1,
      `${inbox.filter((m) => m.type === "doc.changed").length} doc.changed`,
    );

    const tree = await request({ id: "11", type: "doc.list", space: "ENG" });
    const authoredPage = tree.find((page) => page.pageId === "new-회원등급");
    check(
      "the authored page is in the tree as 신규",
      authoredPage?.isNew === true && authoredPage.path === "ENG/회원 등급 기획서.md",
      JSON.stringify(tree.map((page) => [page.path, page.isNew])),
    );
  } finally {
    ws.close();
    await server.stop();
    rmSync(DIR, { recursive: true, force: true });
  }

  // B4 runs before the verdict: its checks land in the same `results`, and a
  // summary printed ahead of them made a failing background-pull loop exit 0.
  await checkBackgroundPullWiring();

  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.error(`Failed: ${failed.map((r) => r.name).join(", ")}`);
    process.exit(1);
  }
  // Under the parallel runner a lingering handle after a green summary would
  // stall the whole lane: a green suite ends deterministically.
  process.exit(0);
}

/**
 * B4: the daemon wires automatic background pull for every mirrored space —
 * started at daemon start and after each clone, torn down at stop. A short
 * interval (env) plus the initial-clone story again proves the loop runs:
 * after the clone consumes its pairs, the next tick pulls and broadcasts
 * another confluence.status(pulling→idle).
 */
async function checkBackgroundPullWiring() {
  const { loadFixturePairs } = await import("../dist/rest-transport.js");
  const story = [...loadFixturePairs(FIXTURES)]; // clone story again, fresh pairs
  // main() wiped DIR on its way out, registry and all; the second daemon
  // migrates from scratch and needs the same one-project shape.
  mkdirSync(REPO_ROOT, { recursive: true });
  process.env.CDS_DESIGN_BACKGROUND_PULL_MS = "40";
  const port = await freePort();
  const server = new DaemonServer({ host: "127.0.0.1", port, token: "bg-pull" });
  await server.start(); // no mirrored spaces yet → nothing started

  const ws = new WebSocket(`ws://127.0.0.1:${port}?token=bg-pull`);
  const inbox = [];
  ws.on("message", (raw) => inbox.push(JSON.parse(String(raw))));
  await new Promise((resolve) => ws.once("open", resolve));

  try {
    // The reply has to be found in the inbox, not caught with a one-shot
    // listener: the daemon broadcasts the active project's repo.status as soon
    // as a client connects, so the first message on the socket is not the
    // answer to anything (a `ws.once` here waited forever).
    ws.send(JSON.stringify({ id: "bg1", type: "confluence.update", siteUrl: "https://example.atlassian.net", email: "dev@example.com", apiToken: "bg-pull-token" }));
    const credentials = await waitFor(() => inbox.find((m) => m.id === "bg1"), 10_000, "confluence.update");
    if (credentials.type !== "ok") throw new Error(credentials.message);

    // Clone consumes the story; the auto pull then needs its own pairs.
    const cloneReply = await new Promise((resolve, reject) => {
      ws.send(JSON.stringify({ id: "bg2", type: "confluence.sync", space: "ENG" }));
      const timer = setTimeout(() => reject(new Error("clone never settled")), 120_000);
      const tick = setInterval(() => {
        const hit = inbox.find((m) => m.id === "bg2");
        if (hit) {
          clearTimeout(timer);
          clearInterval(tick);
          resolve(hit);
        }
      }, 50);
    });
    check(
      "B4: the clone settles before the loop kicks in",
      cloneReply.data.phase === "idle",
      cloneReply.data.detail ?? "",
    );

    // The background tick pulls the (unchanged) space: expect another
    // pulling→idle broadcast nobody asked for.
    const broadcasts = () => inbox.filter((m) => m.type === "confluence.status" && m.status.phase === "pulling").length;
    const before = broadcasts();
    let autoPulled = false;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      // The pull re-runs the clone story — serve it by reusing the same
      // fixture set the engine was built with (order-strict): each tick
      // consumes nothing new when nothing changed, because listSpacePages
      // hits the FIRST unconsumed pair. Feed it a steady list supply.
      if (broadcasts() > before) {
        autoPulled = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    check("B4: an unrequested pull runs on the timer", autoPulled, `${before} → ${broadcasts()} pulling broadcasts`);

    await server.stop();
    const after = broadcasts();
    await new Promise((resolve) => setTimeout(resolve, 300));
    check("B4: stop() ends the loop", broadcasts() === after, `${after} → ${broadcasts()}`);
  } finally {
    ws.close();
    await server.stop().catch(() => undefined);
    delete process.env.CDS_DESIGN_BACKGROUND_PULL_MS;
  }
}

main().catch((error) => {
  console.error(error);
  rmSync(DIR, { recursive: true, force: true });
  process.exit(1);
});
