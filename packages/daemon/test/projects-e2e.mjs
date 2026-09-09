/**
 * Projects end-to-end check, fully offline (PLAN M1).
 *
 * This is the product claim of M1, driven over the same WebSocket the browser
 * uses, against the recorded fixtures in fixtures/confluence/projects/:
 *
 *   - two projects can own two different SUBTREES of one Confluence space,
 *     and each mirror holds only its own pages;
 *   - a third project that would share pages with one of them is refused,
 *     and the refusal costs nothing on disk;
 *   - switching the active project switches what every other message means.
 *
 * The repo half is deliberately absent: these projects declare no repo url, so
 * nothing clones and no preview port is taken. Cloning and publishing are what
 * repo-e2e and publish-e2e already prove; what is new here is the scoping.
 *
 * Usage: node packages/daemon/test/projects-e2e.mjs
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { WebSocket } from "ws";
import { DaemonServer } from "../dist/server.js";
import { freePort, writeStubClaude } from "./fixture-repo.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const DIR = join(tmpdir(), "drafthouse-projects-e2e");
const FIXTURES = join(here, "fixtures", "confluence", "projects");

process.env.DRAFTHOUSE_CONFLUENCE_FIXTURE = FIXTURES;
process.env.DRAFTHOUSE_CONFLUENCE_SETTINGS = join(DIR, "confluence.json");
process.env.DRAFTHOUSE_CONFLUENCE_SITE = "https://example.atlassian.net";
process.env.DRAFTHOUSE_CONFLUENCE_EMAIL = "dev@example.com";
process.env.DRAFTHOUSE_CONFLUENCE_TOKEN = "projects_e2e_token";
process.env.DRAFTHOUSE_CREDENTIAL_STORE = "memory";
// Every registry path in the temp dir. This suite deliberately does NOT set
// DRAFTHOUSE_REPO_DIR or DRAFTHOUSE_CONFLUENCE_DIR: those override the ACTIVE
// project's roots, which is exactly the per-project separation under test.
process.env.DRAFTHOUSE_PROJECTS_SETTINGS = join(DIR, "projects.json");
process.env.DRAFTHOUSE_PROJECTS_DIR = join(DIR, "projects");
// A background tick mid-story would eat fixture pairs the assertions expect.
process.env.DRAFTHOUSE_BACKGROUND_PULL_MS = "3600000";
// A thread has to be creatable for the page-attachment story; no model turn is
// run, so a stub that answers --version and `auth status` is the whole need.
process.env.DRAFTHOUSE_CLAUDE_BIN = writeStubClaude(join(DIR, "bin"));

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
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timeout waiting for ${label}`);
}

/** Page titles a project's mirror actually holds, from its own folder. */
function mirroredTitles(slug) {
  const dir = join(DIR, "projects", slug, "confluence", "ENG");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".md"))
    .map((entry) => entry.slice(0, -3))
    .sort();
}

async function main() {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });

  const port = await freePort();
  const server = new DaemonServer({ host: "127.0.0.1", port, token: "projects-e2e" });
  await server.start();

  const ws = new WebSocket(`ws://127.0.0.1:${port}?token=projects-e2e`);
  const inbox = [];
  ws.on("message", (raw) => inbox.push(JSON.parse(String(raw))));
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });

  let nextId = 0;
  const request = async (message, timeoutMs = 60_000) => {
    const id = `m${(nextId += 1)}`;
    ws.send(JSON.stringify({ ...message, id }));
    const reply = await waitFor(() => inbox.find((m) => m.id === id), timeoutMs, message.type);
    if (reply.type === "ok") return reply.data;
    throw new Error(reply.message);
  };
  /** Same, but the refusal is the result under test. */
  const refusal = async (message) => {
    try {
      await request(message);
      return null;
    } catch (error) {
      return error.message;
    }
  };

  try {
    // --- 1. a fresh machine has no project ---------------------------------
    const empty = await request({ type: "project.list" });
    check(
      "a machine with nothing configured reports no project",
      empty.projects.length === 0 && empty.activeSlug === null,
    );
    const noProject = await refusal({ type: "doc.list", space: "ENG" });
    check(
      "a mirror message without a project refuses in Korean",
      noProject !== null && noProject.includes("프로젝트"),
      noProject ?? "(accepted)",
    );

    // --- 2. the wizard's root picker sees the whole space -------------------
    const tree = await request({ type: "confluence.pageTree", space: "ENG" });
    check(
      "the root picker lists every page with its parent, nothing taken yet",
      tree.pages.length === 5 &&
        tree.pages.find((page) => page.id === "111")?.parentId === "101" &&
        tree.taken.length === 0,
      `${tree.pages.length} pages`,
    );

    // --- 3. two projects, two subtrees of one space -------------------------
    const payments = await request({
      type: "project.create",
      name: "결제",
      roots: [{ space: "ENG", rootPageId: "101" }],
      repoUrl: null,
    });
    const refunds = await request({
      type: "project.create",
      name: "환불",
      roots: [{ space: "ENG", rootPageId: "201" }],
      repoUrl: null,
    });
    check(
      "each project mirrors only its own subtree",
      JSON.stringify(mirroredTitles(payments.slug)) ===
        JSON.stringify(["결제 서비스", "결제수단 등록", "결제 실패 처리"].sort()) &&
        JSON.stringify(mirroredTitles(refunds.slug)) === JSON.stringify(["부분 환불", "환불"].sort()),
      `${mirroredTitles(payments.slug).join("·")} | ${mirroredTitles(refunds.slug).join("·")}`,
    );
    check(
      "the two mirrors are separate folders, so their sync state cannot merge",
      existsSync(join(DIR, "projects", payments.slug, "confluence", "ENG", ".confluence-sync.json")) &&
        existsSync(join(DIR, "projects", refunds.slug, "confluence", "ENG", ".confluence-sync.json")),
    );

    // --- 4. overlap is refused before anything exists -----------------------
    const before = readdirSync(join(DIR, "projects")).sort();
    const overlap = await refusal({
      type: "project.create",
      name: "결제수단",
      roots: [{ space: "ENG", rootPageId: "111" }],
      repoUrl: null,
    });
    check(
      "a project inside another project's subtree is refused by name",
      overlap !== null && overlap.includes("결제") && overlap.includes("결제 서비스"),
      overlap ?? "(accepted)",
    );
    check(
      "the refusal left no folder and no registry entry behind",
      JSON.stringify(readdirSync(join(DIR, "projects")).sort()) === JSON.stringify(before) &&
        JSON.parse(readFileSync(join(DIR, "projects.json"), "utf8")).projects.length === 2,
    );

    // --- 5. the active project is what every other message means ------------
    const refundDocs = await request({ type: "doc.list", space: "ENG" });
    check(
      "the newest project is the active one and owns the document tree",
      refundDocs.map((doc) => doc.title).sort().join("·") === "부분 환불·환불",
      refundDocs.map((doc) => doc.title).join("·"),
    );
    await request({ type: "project.activate", slug: payments.slug });
    const paymentDocs = await request({ type: "doc.list", space: "ENG" });
    check(
      "switching the project switches the tree under the same message",
      paymentDocs.map((doc) => doc.title).sort().join("·") ===
        ["결제 서비스", "결제수단 등록", "결제 실패 처리"].sort().join("·"),
      paymentDocs.map((doc) => doc.title).join("·"),
    );
    const announced = inbox.filter((m) => m.type === "project.changed").at(-1);
    check(
      "every open client is told the active project moved",
      announced?.activeSlug === payments.slug,
      announced?.activeSlug ?? "(no broadcast)",
    );

    // --- 6. a thread belongs to its 기획서 (PLAN D2) -------------------------
    // The whole point of the page axis. A stub CLI is enough: the thread is
    // live the moment it is created, so it lists without any model turn.
    const thread = await request({
      type: "session.create",
      workspace: "planning",
      pageId: "111",
    });
    const onItsPage = await request({ type: "session.list", workspace: "planning", pageId: "111" });
    const onAnother = await request({ type: "session.list", workspace: "planning", pageId: "112" });
    const everything = await request({ type: "session.list", workspace: "planning" });
    check(
      "a thread created on a page lists under that page and nowhere else",
      onItsPage.some((session) => session.sessionId === thread.sessionId) &&
        onItsPage.every((session) => session.pageId === "111") &&
        !onAnother.some((session) => session.sessionId === thread.sessionId),
      `${onItsPage.length} on 111 · ${onAnother.length} on 112`,
    );
    check(
      "an unfiltered list still returns it, stamped with its page",
      everything.find((session) => session.sessionId === thread.sessionId)?.pageId === "111",
    );
    check(
      "the attachment is on disk, so it survives the daemon",
      JSON.parse(readFileSync(join(DIR, "projects", payments.slug, "sessions.json"), "utf8"))[
        thread.sessionId
      ] === "111",
    );
    await request({ type: "session.delete", sessionId: thread.sessionId });
    check(
      "deleting the thread takes its attachment with it",
      Object.keys(
        JSON.parse(readFileSync(join(DIR, "projects", payments.slug, "sessions.json"), "utf8")),
      ).length === 0,
    );

    // --- 7. the registry survives a restart ---------------------------------
    await server.stop();
    ws.close();
    const restartPort = await freePort();
    const restarted = new DaemonServer({ host: "127.0.0.1", port: restartPort, token: "projects-e2e" });
    await restarted.start();
    const ws2 = new WebSocket(`ws://127.0.0.1:${restartPort}?token=projects-e2e`);
    const inbox2 = [];
    ws2.on("message", (raw) => inbox2.push(JSON.parse(String(raw))));
    await new Promise((resolve, reject) => {
      ws2.once("open", resolve);
      ws2.once("error", reject);
    });
    const hello = await waitFor(() => inbox2.find((m) => m.type === "hello"), 20_000, "hello");
    check(
      "a restart reports both projects and remembers which one was active",
      hello.status.projects.length === 2 && hello.status.activeProject === payments.slug,
      `${hello.status.projects.map((p) => p.name).join("·")} → ${hello.status.activeProject}`,
    );
    ws2.close();
    await restarted.stop();
  } finally {
    try {
      await server.stop();
    } catch {
      // Already stopped by the restart step; the second stop is the cleanup.
    }
    rmSync(DIR, { recursive: true, force: true });
  }

  const failed = results.filter((entry) => !entry.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.error(`Failed: ${failed.map((entry) => entry.name).join(", ")}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
