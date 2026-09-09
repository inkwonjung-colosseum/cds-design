/**
 * Onboarding step checks — offline, against a stubbed PATH (fake git and a
 * fake claude CLI), a local fixture repo remote, and the recorded golden
 * Confluence fixtures. Covers the §8 contract: Korean failure reasons, fix
 * kinds, pass/warn/fail transitions, and the registry→npmrc merge.
 *
 * Run: node --test packages/daemon/test/onboarding.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runOnboardingChecks, startClaudeInstall, startClaudeLogin } from "../dist/onboarding.js";
import { RepoWorkspace } from "../dist/repo.js";
import { SyncEngine, resolveConfluenceRoot } from "../dist/sync/sync-engine.js";
import { ConfluenceClient } from "../dist/sync/confluence-client.js";
import { createConfluenceTransport } from "../dist/sync/fixture-transport.js";
import {
  confluenceCredentials,
  loadConfluenceSettings,
  confluenceConfigured,
} from "../dist/sync/confluence-settings.js";
import { mergeNpmrc, npmrcPath } from "../dist/credentials.js";
import { createFixtureRepo, freePort, writeStubClaude } from "./fixture-repo.mjs";

const here = dirname(fileURLToPath(import.meta.url));
// The onboarding story has its own strictly-ordered fixtures: listSpaces for
// the check, the same list for clone's find-space, an empty page list, then a
// final listSpaces for the closing check. The client test consumes `golden`.
const ONBOARDING = join(here, "fixtures", "confluence", "onboarding");

function workdir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A PATH whose git answers --version and delegates everything else. */
function stubPath(dir, { gitVersion = true } = {}) {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const git = join(bin, "git");
  writeFileSync(
    git,
    gitVersion
      ? '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "git version 2.50.0-stub"; exit 0; fi\nexec /usr/bin/git "$@"\n'
      : "#!/bin/sh\nexit 127\n",
  );
  chmodSync(git, 0o755);
  return bin;
}

const find = (steps, id) => steps.find((step) => step.id === id);

async function buildHarness(overrides) {
  const dir = workdir("hub-onboard-");
  const root = join(dir, "repo");
  // Every credential lookup has to land in this harness's own temp dir: left
  // on the default path `loadConfluenceSettings` reads the developer's real
  // ~/drafthouse/config/confluence.json, and a check that should have been
  // offline goes out to their actual site.
  const env = { DRAFTHOUSE_CONFLUENCE_SETTINGS: join(dir, "confluence.json"), ...overrides };
  const transport = createConfluenceTransport({ ...process.env, ...env });
  const token = env.DRAFTHOUSE_CONFLUENCE_TOKEN ?? null;
  const clientFactory = () => {
    const stored = confluenceCredentials(loadConfluenceSettings(env), env, token);
    if (!confluenceConfigured(stored)) return null;
    return new ConfluenceClient(
      {
        siteUrl: stored.siteUrl ?? "https://example.atlassian.net",
        email: stored.email ?? "dev@example.com",
        apiToken: stored.apiToken ?? "token",
      },
      transport.transport ?? null,
    );
  };
  const repo = new RepoWorkspace({
    root,
    url: env.DRAFTHOUSE_REPO_URL ?? null,
    pat: env.DRAFTHOUSE_REPO_PAT ?? null,
    onStatus: () => undefined,
  });
  const confluence = new SyncEngine({
    root: join(dir, "mirror"),
    clientFactory,
    onStatus: () => undefined,
  });
  return { dir, repo, confluence, clientFactory, transport };
}

test("every step fails in Korean on an empty machine, with fixes where offered", async () => {
  const dir = workdir("hub-onboard-empty-");
  const previousPath = process.env.PATH;
  const previousHome = process.env.HOME;
  const previousClaudeBin = process.env.DRAFTHOUSE_CLAUDE_BIN;
  try {
    // A genuinely empty machine: nothing on PATH, no HOME-owned installs.
    // (The resolver probes well-known absolute locations, so only a real
    // HOME/PATH override makes claude and git unfindable.)
    process.env.HOME = dir;
    process.env.PATH = join(dir, "empty-bin");
    delete process.env.DRAFTHOUSE_CLAUDE_BIN;
    const repo = new RepoWorkspace({ root: join(dir, "repo"), url: null, onStatus: () => undefined });
    const confluence = new SyncEngine({ root: join(dir, "mirror"), clientFactory: () => null, onStatus: () => undefined });
    const steps = await runOnboardingChecks({ repo, confluence, confluenceClient: () => null });

    const claude = find(steps, "claude");
    assert.equal(claude.status, "fail");
    assert.match(claude.detail, /Claude Code CLI를 찾지 못했습니다/);
    assert.deepEqual(claude.fix, { kind: "install-claude", label: "Claude Code 설치" });

    const git = find(steps, "git");
    assert.equal(git.status, "fail");
    assert.match(git.detail, /git이 없습니다/);

    const projectStep = find(steps, "project");
    assert.equal(projectStep.status, "fail");
    assert.match(projectStep.detail, /연결 레포 주소가 설정되지 않았습니다/);

    const confluenceStep = find(steps, "confluence");
    assert.equal(confluenceStep.status, "fail");
    assert.match(confluenceStep.detail, /Confluence 연결 정보가 설정되지 않았습니다/);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousClaudeBin === undefined) delete process.env.DRAFTHOUSE_CLAUDE_BIN;
    else process.env.DRAFTHOUSE_CLAUDE_BIN = previousClaudeBin;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a logged-out claude asks for login; an API key shadows the subscription", async () => {
  const dir = workdir("hub-onboard-claude-");
  try {
    const stub = join(dir, "claude-logged-out");
    writeFileSync(
      stub,
      '#!/bin/sh\ncase "$1" in --version) echo "1.0.0-stub";; auth) echo \'{"loggedIn":false}\'; exit 0;; esac\nexit 0\n',
    );
    chmodSync(stub, 0o755);
    const repo = new RepoWorkspace({ root: join(dir, "repo"), url: null, onStatus: () => undefined });
    const confluence = new SyncEngine({ root: join(dir, "mirror"), clientFactory: () => null, onStatus: () => undefined });

    const loggedOut = await runOnboardingChecks({
      claudeExecutableOverride: stub,
      repo,
      confluence,
      confluenceClient: () => null,
    });
    const step = find(loggedOut, "claude");
    assert.equal(step.status, "fail");
    assert.match(step.detail, /로그인이 필요합니다/);
    assert.equal(step.fix?.kind, "login-claude");

    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-test";
    try {
      const loggedIn = await runOnboardingChecks({
        claudeExecutableOverride: writeStubClaude(join(dir, "bin-ok")),
        repo,
        confluence,
        confluenceClient: () => null,
      });
      const shadowed = find(loggedIn, "claude");
      assert.equal(shadowed.status, "warn");
      assert.match(shadowed.detail, /ANTHROPIC_API_KEY/);
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("git passes through the stub and fails with CLT guidance when missing", async () => {
  const dir = workdir("hub-onboard-git-");
  try {
    const ok = stubPath(dir);
    const repo = new RepoWorkspace({ root: join(dir, "repo"), url: null, onStatus: () => undefined });
    const confluence = new SyncEngine({ root: join(dir, "mirror"), clientFactory: () => null, onStatus: () => undefined });
    const deps = { repo, confluence, confluenceClient: () => null };

    // The stub only counts when it is actually on PATH, ahead of the real git.
    const previousPath = process.env.PATH;
    process.env.PATH = `${ok}:${previousPath}`;
    const withGit = await runOnboardingChecks(deps);
    assert.equal(find(withGit, "git").status, "pass");
    assert.match(find(withGit, "git").detail, /2\.50\.0-stub/);

    rmSync(ok, { recursive: true, force: true });
    const broken = stubPath(dir, { gitVersion: false });
    process.env.PATH = `${broken}:/usr/bin:/bin`;
    try {
      const without = await runOnboardingChecks(deps);
      const step = find(without, "git");
      assert.equal(step.status, "fail");
      assert.match(step.detail, /xcode-select --install/);
      assert.equal(step.fix?.kind, "install-git");
    } finally {
      process.env.PATH = previousPath;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The project gate is the old repo gate plus the mirror: a project that
 * cannot reach its repo is broken, one that has not cloned it yet is a warn,
 * and one with nothing mirrored has no 기획서 to build a screen from — which
 * the planner cannot tell from a repo-shaped message.
 */
test("the project step: unreachable fails, uncloned warns, an empty mirror warns, then it passes", async () => {
  const dir = workdir("hub-onboard-project-");
  process.env.DRAFTHOUSE_CREDENTIAL_STORE = "memory";
  try {
    const fixture = await createFixtureRepo({ dir: join(dir, "fixture"), port: await freePort() });
    const harness = await buildHarness({
      DRAFTHOUSE_REPO_URL: join(dir, "nope.git"),
      DRAFTHOUSE_CREDENTIAL_STORE: "memory",
    });

    const unreachable = await runOnboardingChecks({
      repo: harness.repo,
      confluence: harness.confluence,
      confluenceClient: harness.clientFactory,
    });
    const step = find(unreachable, "project");
    assert.equal(step.status, "fail");
    assert.match(step.detail, /접근하지 못했습니다/);
    await harness.repo.stop();

    // A reachable remote that is not cloned yet is a non-blocking warn. The
    // credentials are real from here on: the mirror is what the last two
    // states turn on, so this harness has to be able to clone one.
    const pending = await buildHarness({
      DRAFTHOUSE_REPO_URL: fixture.remote,
      DRAFTHOUSE_CREDENTIAL_STORE: "memory",
      DRAFTHOUSE_CONFLUENCE_SITE: "https://example.atlassian.net",
      DRAFTHOUSE_CONFLUENCE_EMAIL: "dev@example.com",
      DRAFTHOUSE_CONFLUENCE_TOKEN: "onboard-token",
      DRAFTHOUSE_CONFLUENCE_FIXTURE: ONBOARDING,
    });
    const deps = {
      repo: pending.repo,
      confluence: pending.confluence,
      projectName: "회원 관리 개편",
      confluenceClient: pending.clientFactory,
    };
    const warnStep = find(await runOnboardingChecks(deps), "project");
    assert.equal(warnStep.status, "warn", warnStep.detail);
    assert.equal(warnStep.fix?.kind, "repo-install");
    await pending.repo.stop();

    // Cloned and installed, but nothing mirrored: still a warn, and the fix
    // is the 기획서 clone rather than the repo one.
    await pending.repo.sync();
    const mirrorStep = find(await runOnboardingChecks(deps), "project");
    assert.equal(mirrorStep.status, "warn", mirrorStep.detail);
    assert.match(mirrorStep.detail, /기획서 미러가 비어 있습니다/);
    assert.equal(mirrorStep.fix?.kind, "confluence-sync");

    // With both halves in place the gate passes, naming the project.
    await pending.confluence.clone("ENG");
    const passStep = find(await runOnboardingChecks(deps), "project");
    assert.equal(passStep.status, "pass", passStep.detail);
    assert.match(passStep.detail, /^회원 관리 개편 준비됨 — /);
    await pending.repo.stop();
  } finally {
    delete process.env.DRAFTHOUSE_CREDENTIAL_STORE;
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The whole first-run contract: before any project exists the gate has
 * nothing to check and nothing to press. Creating one needs a name, a
 * Confluence location and a repo url, so the wizard's own form is the fix and
 * a button here would only lead back to it.
 */
test("the project step with no project at all: fails, says what to do, offers no fix", async () => {
  const steps = await runOnboardingChecks({
    repo: null,
    confluence: null,
    confluenceClient: () => null,
  });
  const step = find(steps, "project");
  assert.equal(step.status, "fail");
  assert.match(step.detail, /프로젝트가 없습니다/);
  assert.match(step.detail, /Confluence 위치와 연결 레포/);
  assert.equal(step.fix, undefined, "the wizard's form is the fix, not a button");
});

test("the confluence step: unconfigured fails, credentials alone pass with the space list", async () => {
  const dir = workdir("hub-onboard-conf-");
  try {
    // Unconfigured: fail, Korean reason.
    const empty = await buildHarness({ DRAFTHOUSE_CONFLUENCE_SETTINGS: join(dir, "settings.json") });
    assert.equal(find(await runOnboardingChecks({
      repo: empty.repo, confluence: empty.confluence, confluenceClient: empty.clientFactory,
    }), "confluence").status, "fail");

    // The gate is machine-wide and credentials-only now: authenticating is
    // the whole bar. What is mirrored belongs to a project, and the project
    // gate is where an empty mirror is reported.
    const harness = await buildHarness({
      DRAFTHOUSE_CONFLUENCE_SETTINGS: join(dir, "settings.json"),
      DRAFTHOUSE_CONFLUENCE_SITE: "https://example.atlassian.net",
      DRAFTHOUSE_CONFLUENCE_EMAIL: "dev@example.com",
      DRAFTHOUSE_CONFLUENCE_TOKEN: "onboard-token",
      DRAFTHOUSE_CONFLUENCE_FIXTURE: ONBOARDING,
    });
    const step = find(
      await runOnboardingChecks({
        repo: harness.repo,
        confluence: harness.confluence,
        confluenceClient: harness.clientFactory,
      }),
      "confluence",
    );
    assert.equal(step.status, "pass", step.detail);
    assert.equal(step.fix, undefined);
    // The list rides along: the project wizard's location picker starts here.
    assert.deepEqual(step.spaces, [{ id: "9001", key: "ENG", name: "엔지니어링" }]);
    assert.match(step.detail, /스페이스 1개/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a declared registry merges into the user's npmrc without clobbering", () => {
  const home = workdir("hub-onboard-npm-");
  try {
    const file = npmrcPath({ HOME: home });
    writeFileSync(file, "registry=https://registry.npmjs.org/\n");
    mergeNpmrc(file, [
      { key: "@colosseumcoinckr:registry", value: "https://npm.pkg.github.com/" },
      { key: "//npm.pkg.github.com/:_authToken", value: "ghp_registry" },
    ]);
    const merged = readFileSync(file, "utf8");
    assert.ok(merged.includes("registry=https://registry.npmjs.org/"));
    assert.ok(merged.includes("@colosseumcoinckr:registry=https://npm.pkg.github.com/"));
    assert.ok(merged.includes("_authToken=ghp_registry"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});


// ---------------------------------------------------------------------------
// PAT redaction in the repo step (B2)
// ---------------------------------------------------------------------------

test("B2: an ls-remote failure never leaks the PAT into the step detail", async () => {
  const dir = workdir("hub-onboard-leak-");
  try {
    const repo = new RepoWorkspace({
      root: join(dir, "repo"),
      // A refused local port: git fails fast and quotes the authenticated
      // remote url — PAT included — in its own error output.
      url: "https://127.0.0.1:9/org/repo.git",
      pat: "ghp_leak_probe_secret",
      onStatus: () => undefined,
    });
    const confluence = new SyncEngine({ root: join(dir, "mirror"), clientFactory: () => null, onStatus: () => undefined });
    const steps = await runOnboardingChecks({
      repo,
      confluence,
      confluenceClient: () => null,
    });
    const step = steps.find((candidate) => candidate.id === "project");
    assert.equal(step.status, "fail");
    assert.match(step.detail, /접근하지 못했습니다/);
    assert.ok(!step.detail.includes("ghp_leak_probe_secret"), `PAT leaked: ${step.detail}`);
    assert.ok(!JSON.stringify(steps).includes("ghp_leak_probe_secret"), "no step carries it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Spawn hardening for the fix flows (B3)
// ---------------------------------------------------------------------------

/** A spawn double that throws synchronously — ENOENT before a child exists. */
function throwingSpawn() {
  throw new Error("spawn ENOENT");
}

/** A spawn double whose children only fail asynchronously (real ENOENT shape). */
function eventingSpawn() {
  const children = [];
  const spawnLike = () => {
    const listeners = new Map();
    const child = {
      once: (event, handler) => listeners.set(event, handler),
      unref: () => undefined,
      emitError: () => listeners.get("error")?.(new Error("spawn ENOENT")),
    };
    children.push(child);
    return child;
  };
  spawnLike.children = children;
  return spawnLike;
}

test("B3: a failing installer spawn returns guidance instead of throwing", () => {
  const result = startClaudeInstall(throwingSpawn);
  assert.equal(result.started, false);
  assert.match(result.guidance, /직접 실행해 주세요/);
});

test("B3: a failing login spawn returns guidance instead of throwing", () => {
  const originalPlatform = process.platform;
  if (originalPlatform === "darwin") {
    // The darwin branch tries osascript first; the double throws for it too
    // and falls through to the plain spawn, which throws again → guidance.
    const result = startClaudeLogin(throwingSpawn);
    assert.equal(result.started, false);
    assert.match(result.guidance, /직접 실행해 주세요/);
  } else {
    const result = startClaudeLogin(throwingSpawn);
    assert.equal(result.started, false);
  }
});

test("B3: an async spawn error is absorbed, never an unhandled crash", async () => {
  const factory = eventingSpawn();
  const install = startClaudeInstall(factory);
  assert.equal(install.started, true);
  assert.ok(factory.children.length >= 1, "a child was spawned");
  // The detached child dies asynchronously; without the error listener this
  // would crash the process. Every spawned child firing 'error' must be a
  // no-op the caller survives.
  for (const child of factory.children) child.emitError();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(true, "still standing after every detached child errored");
});

// ---------------------------------------------------------------------------
// Transport selection: the real site url must reach fetch
// ---------------------------------------------------------------------------

test("no fixture env → transport is null so the caller builds a per-site FetchTransport", () => {
  const env = { ...process.env };
  delete env.DRAFTHOUSE_CONFLUENCE_FIXTURE;
  const chosen = createConfluenceTransport(env);
  // A non-null placeholder here shadowed the `?? new FetchTransport(siteUrl)`
  // fallback and every request went to a relative url
  // ("Failed to parse URL from /wiki/api/v2/spaces?limit=100").
  assert.equal(chosen.transport, null);
  assert.equal(chosen.fixtureDir, null);
});

test("FetchTransport builds an absolute url from the configured site", async () => {
  const { FetchTransport, normalizeSiteUrl } = await import("../dist/sync/fixture-transport.js");
  assert.equal(normalizeSiteUrl(" https://example.atlassian.net/ "), "https://example.atlassian.net");
  assert.equal(normalizeSiteUrl("example.atlassian.net"), "https://example.atlassian.net");
  assert.equal(normalizeSiteUrl("   "), "");

  const seen = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    return new Response(JSON.stringify({ results: [] }), { status: 200 });
  };
  try {
    const transport = new FetchTransport("https://example.atlassian.net/");
    const client = new ConfluenceClient(
      { siteUrl: "https://example.atlassian.net", email: "dev@example.com", apiToken: "token" },
      transport,
    );
    await client.listSpaces(100);
    // The regression is the RELATIVE url ("Failed to parse URL from
    // /wiki/api/v2/spaces?limit=100"), so every request the client makes has
    // to be absolute against the configured site — how many it makes (it also
    // asks who is signed in, best-effort) is not this test's business.
    assert.ok(seen.includes("https://example.atlassian.net/wiki/api/v2/spaces?limit=100"), seen.join(" "));
    for (const url of seen) assert.ok(url.startsWith("https://example.atlassian.net/"), url);

    await assert.rejects(
      () => new FetchTransport("").request({ method: "GET", url: "/wiki/api/v2/spaces", headers: {} }),
      /사이트 주소가 비어 있습니다/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
