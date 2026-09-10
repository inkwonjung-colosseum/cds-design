/**
 * Credential store checks — memory backend semantics, plaintext migration,
 * npmrc merging, and a real Keychain round-trip on macOS (run-unique service
 * name, skipped loudly when the security CLI is unavailable).
 *
 * Run: node --test packages/daemon/test/credentials.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CREDENTIAL_SERVICE,
  CONFLUENCE_TOKEN_ITEM,
  DpapiCredentialStore,
  KeychainCredentialStore,
  MemoryCredentialStore,
  REPO_PAT_ITEM,
  createCredentialStore,
  loadConfluenceToken,
  loadRepoPat,
  mergeNpmrc,
  migratePlaintextSecrets,
  npmrcPath,
} from "../dist/credentials.js";
import { repoPatItem } from "../dist/projects.js";

function workdir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("the memory store saves, loads, deletes", async () => {
  const store = new MemoryCredentialStore();
  assert.equal(await store.load(REPO_PAT_ITEM), null);
  await store.save(REPO_PAT_ITEM, "ghp_secret");
  assert.equal(await store.load(REPO_PAT_ITEM), "ghp_secret");
  await store.save(REPO_PAT_ITEM, "ghp_rotated"); // replace, not append
  assert.equal(await store.load(REPO_PAT_ITEM), "ghp_rotated");
  await store.delete(REPO_PAT_ITEM);
  assert.equal(await store.load(REPO_PAT_ITEM), null);
});

test("the DPAPI store refuses with the desktop Korean message", async () => {
  const store = new DpapiCredentialStore();
  await assert.rejects(() => store.save("pat", "x"), /desktop 버전에서 제공됩니다/);
  await assert.rejects(() => store.load("pat"), /desktop 버전에서 제공됩니다/);
  await assert.rejects(() => store.delete("pat"), /desktop 버전에서 제공됩니다/);
});

test("the factory honors CDS_DESIGN_CREDENTIAL_STORE", () => {
  assert.equal(createCredentialStore({ CDS_DESIGN_CREDENTIAL_STORE: "memory" }).kind, "memory");
  assert.equal(createCredentialStore({ CDS_DESIGN_CREDENTIAL_STORE: "keychain" }).kind, "keychain");
});

test("migration moves plaintext secrets out of the settings files", async () => {
  const dir = workdir("hub-cred-migrate-");
  try {
    const repoFile = join(dir, "repo.json");
    const confluenceFile = join(dir, "confluence.json");
    writeFileSync(repoFile, `${JSON.stringify({ url: "https://github.com/org/repo.git", pat: "ghp_plain" }, null, 2)}\n`);
    writeFileSync(confluenceFile, `${JSON.stringify({ siteUrl: "https://x.atlassian.net", email: "a@b.c", apiToken: "tok_plain" }, null, 2)}\n`);

    const store = new MemoryCredentialStore();
    const report = await migratePlaintextSecrets(store, {
      CDS_DESIGN_REPO_SETTINGS: repoFile,
      CDS_DESIGN_CONFLUENCE_SETTINGS: confluenceFile,
    });

    assert.deepEqual(report.migrated.sort(), [CONFLUENCE_TOKEN_ITEM, REPO_PAT_ITEM]);
    assert.equal(await store.load(REPO_PAT_ITEM), "ghp_plain");
    assert.equal(await store.load(CONFLUENCE_TOKEN_ITEM), "tok_plain");
    const repo = JSON.parse(readFileSync(repoFile, "utf8"));
    assert.deepEqual(repo, { url: "https://github.com/org/repo.git" }, "the file keeps only the url");
    const confluence = JSON.parse(readFileSync(confluenceFile, "utf8"));
    assert.deepEqual(confluence, { siteUrl: "https://x.atlassian.net", email: "a@b.c" });
    assert.ok(!readFileSync(repoFile, "utf8").includes("ghp_plain"));
    assert.ok(!readFileSync(confluenceFile, "utf8").includes("tok_plain"));

    // Idempotent: a second run has nothing to move.
    const again = await migratePlaintextSecrets(store, {
      CDS_DESIGN_REPO_SETTINGS: repoFile,
      CDS_DESIGN_CONFLUENCE_SETTINGS: confluenceFile,
    });
    assert.deepEqual(again, { migrated: [], kept: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("migration keeps plaintext when the store cannot take it", async () => {
  const dir = workdir("hub-cred-keep-");
  try {
    const repoFile = join(dir, "repo.json");
    writeFileSync(repoFile, `${JSON.stringify({ url: "https://github.com/org/repo.git", pat: "ghp_plain" })}\n`);
    const report = await migratePlaintextSecrets(new DpapiCredentialStore(), {
      CDS_DESIGN_REPO_SETTINGS: repoFile,
    });
    assert.deepEqual(report, { migrated: [], kept: [REPO_PAT_ITEM] });
    assert.ok(readFileSync(repoFile, "utf8").includes("ghp_plain"), "nothing is lost");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("env overrides win over the store; absent env falls through", async () => {
  const store = new MemoryCredentialStore();
  await store.save(REPO_PAT_ITEM, "from-store");
  assert.equal(await loadRepoPat(store, null, {}), "from-store");
  assert.equal(await loadRepoPat(store, null, { CDS_DESIGN_REPO_PAT: "from-env" }), "from-env");
  await store.save(CONFLUENCE_TOKEN_ITEM, "token-store");
  assert.equal(await loadConfluenceToken(store, { CDS_DESIGN_CONFLUENCE_TOKEN: "token-env" }), "token-env");
});

test("a slug reads that project's PAT; no slug reads the pre-projects one", async () => {
  const store = new MemoryCredentialStore();
  await store.save(REPO_PAT_ITEM, "legacy-pat");
  await store.save(repoPatItem("alpha"), "alpha-pat");

  assert.equal(await loadRepoPat(store, "alpha", {}), "alpha-pat");
  assert.equal(await loadRepoPat(store, undefined, {}), "legacy-pat");
  assert.equal(await loadRepoPat(store, "beta", {}), null, "a project without a PAT is not handed another's");
  // Headless deploys and the e2e suites configure the PAT by environment; that
  // has to keep winning whichever project is active.
  assert.equal(await loadRepoPat(store, "alpha", { CDS_DESIGN_REPO_PAT: "from-env" }), "from-env");
});

test("npmrc merging replaces its own keys and keeps everything else", () => {
  const dir = workdir("hub-cred-npmrc-");
  try {
    const file = join(dir, ".npmrc");
    writeFileSync(file, "registry=https://registry.npmjs.org/\n@org:registry=https://npm.pkg.github.com/\n//npm.pkg.github.com/:_authToken=stale\nalways-auth=true\n");
    mergeNpmrc(file, [
      { key: "@org:registry", value: "https://npm.pkg.github.com/" },
      { key: "//npm.pkg.github.com/:_authToken", value: "fresh-token" },
    ]);
    const merged = readFileSync(file, "utf8");
    assert.ok(merged.includes("registry=https://registry.npmjs.org/"), "unrelated lines survive");
    assert.ok(merged.includes("always-auth=true"));
    assert.ok(merged.includes("_authToken=fresh-token"));
    assert.ok(!merged.includes("_authToken=stale"), "its own key is replaced, not duplicated");
    assert.equal(merged.split("_authToken").length - 1, 1);

    // A fresh file gains both lines.
    const fresh = join(dir, "fresh.npmrc");
    mergeNpmrc(fresh, [{ key: "@org:registry", value: "https://npm.pkg.github.com/" }]);
    assert.ok(existsSync(fresh));
    assert.ok(readFileSync(fresh, "utf8").includes("@org:registry="));
    assert.equal(npmrcPath({ HOME: dir }), join(dir, ".npmrc"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the macOS Keychain round-trips under a run-unique service", async (t) => {
  if (process.platform !== "darwin" || !existsSync("/usr/bin/security")) {
    console.log("SKIP  macOS Keychain 확인을 건너뜁니다 — 이 환경에는 security CLI가 없습니다.");
    t.skip("security CLI unavailable");
    return;
  }
  const service = `${CREDENTIAL_SERVICE}-test-${process.pid}-${Date.now().toString(36)}`;
  const store = new KeychainCredentialStore(service);
  try {
    // Tokens are ASCII by construction; the security CLI prints non-ASCII
    // bytes back as hex, so the store's contract is ASCII secrets.
    await store.save(REPO_PAT_ITEM, "keychain-secret-with spaces");
    assert.equal(await store.load(REPO_PAT_ITEM), "keychain-secret-with spaces");
    await store.delete(REPO_PAT_ITEM);
    assert.equal(await store.load(REPO_PAT_ITEM), null, "deleted secrets read as null");
  } finally {
    await store.delete(REPO_PAT_ITEM).catch(() => undefined);
  }
});

