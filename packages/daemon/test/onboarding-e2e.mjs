/**
 * Onboarding end-to-end check, fully offline: the four §8 gates driven over
 * the real DaemonServer WebSocket — a local fixture repo as the connected
 * repo, the recorded onboarding Confluence fixtures, and the memory
 * credential store. The story walks the wizard's exact sequence as M1
 * reshaped it: a first run with no project at all, machine-wide Confluence
 * credentials, the location picker's page tree, `project.create` (which
 * mirrors the picked subtree), the repo fix, and the tab gate opening when
 * every step passes.
 *
 * Nothing here points CDS_DESIGN_REPO_URL at the fixture remote: this suite
 * is the one that must see a genuinely first run, so the registry migration
 * finds no legacy repo, no legacy url and no mirrored space, and the daemon
 * comes up with zero projects.
 *
 * Usage: node packages/daemon/test/onboarding-e2e.mjs
 */
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { WebSocket } from "ws";
import { DaemonServer } from "../dist/server.js";
import { createFixtureRepo, freePort } from "./fixture-repo.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const DIR = join(tmpdir(), "cds-design-onboard-e2e");
const ONBOARDING_FIXTURES = join(here, "fixtures", "confluence", "onboarding");
const API_TOKEN = "onboard_e2e_token";
const REPO_PAT = "onboard_e2e_pat";

process.env.CDS_DESIGN_CREDENTIAL_STORE = "memory";
process.env.CDS_DESIGN_CONFLUENCE_DIR = join(DIR, "mirror");
process.env.CDS_DESIGN_CONFLUENCE_SETTINGS = join(DIR, "confluence.json");
process.env.CDS_DESIGN_CONFLUENCE_FIXTURE = ONBOARDING_FIXTURES;
process.env.CDS_DESIGN_REPO_DIR = join(DIR, "work");
process.env.CDS_DESIGN_REPO_SETTINGS = join(DIR, "repo.json");
// The project registry decides whether this run has a project at all, so it
// must be this run's own file: on the default path the daemon would write
// ~/cds-design/config/projects.json and the next run would start already
// migrated, from a fixture remote that no longer exists.
process.env.CDS_DESIGN_PROJECTS_SETTINGS = join(DIR, "projects.json");
process.env.CDS_DESIGN_PROJECTS_DIR = join(DIR, "projects");
// B4 wizard wiring: the timer must start for the space the wizard mirrors on
// its way through `project.create` too — short interval so the regression
// observes a tick without anybody asking for a pull.
process.env.CDS_DESIGN_BACKGROUND_PULL_MS = "120";

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

function step(steps, id) {
  return steps.find((entry) => entry.id === id);
}

async function main() {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  const fixture = await createFixtureRepo({ dir: join(DIR, "fixture"), port: await freePort() });

  const port = await freePort();
  const server = new DaemonServer({ host: "127.0.0.1", port, token: "onboard-e2e" });
  await server.start();

  const ws = new WebSocket(`ws://127.0.0.1:${port}?token=onboard-e2e`);
  const inbox = [];
  ws.on("message", (raw) => inbox.push(JSON.parse(String(raw))));
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });

  const request = async (message, timeoutMs = 120_000) => {
    ws.send(JSON.stringify(message));
    const reply = await waitFor(() => inbox.find((m) => m.id === message.id), timeoutMs, message.type);
    if (reply.type === "ok") return reply.data;
    throw new Error(`${message.type} failed: ${reply.message}`);
  };
  const checkAll = async () => request({ id: `c${Math.random()}`, type: "onboarding.check" });
  const tabsOpen = (steps) => !steps.some((entry) => entry.status === "fail");

  try {
    // --- 1. a genuinely first run: no project at all ----------------------
    const first = await checkAll();
    check(
      "the first check reports the four §8 steps in order",
      JSON.stringify(first.map((entry) => entry.id)) === '["claude","git","confluence","project"]',
      first.map((entry) => `${entry.id}:${entry.status}`).join(" "),
    );
    check(
      "the project step fails with no fix — only the wizard's own form clears it",
      step(first, "project").status === "fail" &&
        /프로젝트가 없습니다/.test(step(first, "project").detail) &&
        step(first, "project").fix === undefined,
      step(first, "project").detail,
    );
    check(
      "the confluence step fails unconfigured",
      step(first, "confluence").status === "fail" &&
        /Confluence 연결 정보가 설정되지 않았습니다/.test(step(first, "confluence").detail),
      step(first, "confluence").detail,
    );
    check("the tab gate is closed on the first run", tabsOpen(first) === false);

    // Everything that means "the repo" or "the mirror" has no referent yet;
    // the daemon has to say so instead of inventing one.
    const noProject = await request({ id: "r0", type: "repo.status" }).catch((error) => error);
    check(
      "repo.status refuses in Korean while no project exists",
      noProject instanceof Error && /프로젝트가 없습니다/.test(noProject.message),
      String(noProject.message ?? noProject),
    );

    // --- 2. machine-wide Confluence credentials --------------------------
    await request({
      id: "u1",
      type: "confluence.update",
      siteUrl: "https://example.atlassian.net",
      email: "dev@example.com",
      apiToken: API_TOKEN,
    });
    const second = await checkAll();
    const confluence = step(second, "confluence");
    check(
      "the confluence step passes on credentials alone, carrying the space list",
      confluence.status === "pass" &&
        confluence.fix === undefined &&
        JSON.stringify(confluence.spaces) === '[{"id":"9001","key":"ENG","name":"엔지니어링"}]',
      confluence.detail,
    );
    check(
      "the confluence token never crosses the wire back",
      !JSON.stringify(inbox).includes(API_TOKEN),
    );
    check(
      "the project step still fails: credentials are not a project",
      step(second, "project").status === "fail" && step(second, "project").fix === undefined,
      step(second, "project").detail,
    );

    // --- 3. the wizard's location picker ----------------------------------
    const tree = await request({ id: "t1", type: "confluence.pageTree", space: "ENG" });
    check(
      "the page tree answers with the space's pages and nothing taken yet",
      tree.space === "ENG" && Array.isArray(tree.pages) && tree.taken.length === 0,
      `${tree.pages.length} pages, ${tree.taken.length} taken`,
    );

    // --- 4. project.create is the fix for the project gate -----------------
    const created = await request({
      id: "p1",
      type: "project.create",
      name: "회원 관리 개편",
      roots: [{ space: "ENG", rootPageId: null }],
      repoUrl: fixture.remote,
      repoPat: REPO_PAT,
    });
    check(
      "project.create returns the project it mirrored",
      created.name === "회원 관리 개편" &&
        created.repoUrl === fixture.remote &&
        created.roots.length === 1 &&
        created.roots[0].space === "ENG" &&
        created.roots[0].rootPageId === null &&
        created.roots[0].title === "엔지니어링",
      JSON.stringify(created),
    );
    check(
      // The PAT the wizard typed is saved under this project's credential item
      // and has to reach the live workspace in the same breath: the very next
      // thing that happens is a clone, and a private repo needs it.
      "project.create arms the workspace with the PAT it was given",
      created.repoPatConfigured === true,
      `repoPatConfigured=${created.repoPatConfigured}`,
    );

    // --- the wizard's clone gets a background-pull timer (B4, gen-3) -------
    // Nobody sends another request: if the wiring is right, the timer ticks
    // within a couple of intervals and broadcasts a pulling→idle status.
    // `project.create` is where the wizard's clone happens now, so this is
    // the path that has to arm it.
    const beforePulls = inbox.filter((m) => m.type === "confluence.status" && m.status.phase === "pulling").length;
    let wizardAutoPull = false;
    for (const deadline = Date.now() + 5000; Date.now() < deadline; ) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (inbox.filter((m) => m.type === "confluence.status" && m.status.phase === "pulling").length > beforePulls) {
        wizardAutoPull = true;
        break;
      }
    }
    check("the wizard's clone gets an unrequested background pull", wizardAutoPull);

    // --- 5. the repo fix, which the project gate offers --------------------
    const fixed = await request({ id: "f1", type: "onboarding.fix", kind: "repo-install" });
    check("the repo fix clones and readies the workspace", fixed.phase === "ready", fixed.detail ?? "");
    check(
      "the PAT never crosses the wire back",
      !JSON.stringify(inbox).includes(REPO_PAT),
      `${inbox.length} messages inspected`,
    );

    // --- 6. every gate open ------------------------------------------------
    const last = await checkAll();
    check(
      "every step passes once the project is ready",
      last.every((entry) => entry.status === "pass"),
      last.map((entry) => `${entry.id}:${entry.status}`).join(" "),
    );
    check(
      "the passing project step names the project and its repo",
      step(last, "project").detail.startsWith("회원 관리 개편 준비됨"),
      step(last, "project").detail,
    );
    check("the tab gate opens", tabsOpen(last) === true);

    const secretsFile = JSON.parse(readFileSync(join(DIR, "confluence.json"), "utf8"));
    check("the confluence settings file holds no plaintext token", !JSON.stringify(secretsFile).includes(API_TOKEN));
    // The repo url lives in the project registry now; that is the file a PAT
    // would leak into if it were ever written next to it.
    const registry = readFileSync(join(DIR, "projects.json"), "utf8");
    check(
      "the project registry holds the repo url and no plaintext PAT",
      registry.includes(fixture.remote) && !registry.includes(REPO_PAT),
    );
  } finally {
    ws.close();
    await server.stop();
    rmSync(DIR, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.error(`Failed: ${failed.map((r) => r.name).join(", ")}`);
    process.exit(1);
  }
  // A green suite ends deterministically — a lingering handle must not stall
  // the parallel runner's lane.
  process.exit(0);
}


main().catch((error) => {
  console.error(error);
  rmSync(DIR, { recursive: true, force: true });
  process.exit(1);
});
