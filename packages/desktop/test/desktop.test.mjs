/**
 * Desktop unit checks — update logic (version compare, feed parse, sha256
 * verify, plan), the safeStorage store against a fake, and the daemon-side
 * PATH prefix. Everything runs offline; the update feed is a local fixture
 * server, the sha256 fixtures are real files.
 *
 * Run: node --test packages/desktop/test/desktop.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import {
  RELEASES_FEED_URL,
  checkForUpdate,
  compareSemver,
  fetchLatest,
} from "../../protocol/dist/update.js";
import {
  planSelfUpdate,
  sha256OfFile,
  verifyDownload,
} from "../dist/mac-self-update.js";
import { SafeStorageCredentialStore } from "../dist/safe-storage-store.js";
import { extraPathPrefix } from "../../daemon/dist/repo.js";

function workdir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// semver compare + update check
// ---------------------------------------------------------------------------

test("semver comparison orders major, minor, patch", () => {
  assert.equal(compareSemver("0.1.0", "0.2.0"), -1);
  assert.equal(compareSemver("1.0.0", "0.9.9"), 1);
  assert.equal(compareSemver("1.2.3", "1.2.3"), 0);
  assert.equal(compareSemver("v1.2.3", "1.2.3"), 0, "the v prefix is tolerated");
  assert.equal(compareSemver("0.1.0", "0.10.0"), -1, "numeric, not lexicographic");
});

test("checkForUpdate reads the feed and compares against the current version", async () => {
  const feed = { version: "0.3.0", notes: "화면 코멘트 지원", url: "https://example/Drafthouse-0.3.0.zip" };
  const fetchLike = async (url) => {
    assert.equal(url, "https://example.test/latest.json");
    return { ok: true, status: 200, json: feed };
  };

  const behind = await checkForUpdate("0.2.0", "https://example.test/latest.json", fetchLike);
  assert.deepEqual(behind, {
    updateAvailable: true,
    version: "0.3.0",
    notes: "화면 코멘트 지원",
    url: "https://example/Drafthouse-0.3.0.zip",
  });

  const current = await checkForUpdate("0.3.0", "https://example.test/latest.json", fetchLike);
  assert.equal(current.updateAvailable, false);
  assert.equal(current.notes, "화면 코멘트 지원");

  const newer = await checkForUpdate("0.4.0", "https://example.test/latest.json", fetchLike);
  assert.equal(newer.updateAvailable, false, "a local build ahead of the feed is not an update");
});

test("feed errors are Korean and shaped for the settings row", async () => {
  await assert.rejects(
    () => fetchLatest("https://x", async () => ({ ok: false, status: 404 })),
    /업데이트 정보를 가져오지 못했습니다 \(exit 404\)/,
  );
  await assert.rejects(
    () => fetchLatest("https://x", async () => ({ ok: true, status: 200, json: { nope: 1 } })),
    /업데이트 정보 형식이 올바르지 않습니다/,
  );
  assert.match(RELEASES_FEED_URL, /latest\.json$/);
});

test("the check flow works against a real local feed server", async () => {
  const dir = workdir("hub-desktop-feed-");
  try {
    writeFileSync(join(dir, "latest.json"), JSON.stringify({ version: "0.5.0", notes: "테스트" }));
    const server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(readFileSync(join(dir, "latest.json")));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    const result = await checkForUpdate("0.4.0", `http://127.0.0.1:${port}/latest.json`, async (url) => {
      const response = await fetch(url);
      return { ok: response.ok, status: response.status, json: await response.json() };
    });
    assert.equal(result.updateAvailable, true);
    assert.equal(result.version, "0.5.0");
    server.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// mac self-update: plan + sha256 verification
// ---------------------------------------------------------------------------

test("the self-update plan names every step and the download target", () => {
  const plan = planSelfUpdate({
    url: "https://example.test/Drafthouse-0.5.0.zip",
    sha256: "ab".repeat(32),
    downloadsDir: "/tmp/downloads",
    version: "0.5.0",
  });
  assert.equal(plan.zipUrl, "https://example.test/Drafthouse-0.5.0.zip");
  assert.equal(plan.downloadPath, "/tmp/downloads/Drafthouse-0.5.0.zip");
  assert.equal(plan.targetApp, "/Applications/Drafthouse.app");
  assert.deepEqual(plan.steps, [
    "Drafthouse-0.5.0.zip 내려받기",
    "sha256 검증",
    "앱 종료",
    "/Applications/Drafthouse.app 교체",
    "다시 실행",
  ]);
});

test("sha256 verification accepts a good file and refuses a bad one", async () => {
  const dir = workdir("hub-desktop-sha-");
  try {
    const good = join(dir, "good.zip");
    const payload = Buffer.from("drafthouse-update-zip-bytes");
    writeFileSync(good, payload);
    const digest = createHash("sha256").update(payload).digest("hex");
    assert.equal(await sha256OfFile(good), digest, "streamed hash matches node's one-shot");
    assert.equal(await verifyDownload(good, digest.toUpperCase()), true, "upper-case digests normalize");

    const bad = join(dir, "bad.zip");
    writeFileSync(bad, Buffer.from("tampered"));
    await assert.rejects(() => verifyDownload(bad, digest), /무결성 검증에 실패했습니다/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// safeStorage credential store (fake)
// ---------------------------------------------------------------------------

/** XOR-obfuscating fake: same interface, no OS behind it. */
function fakeSafeStorage() {
  const key = 0x5a;
  return {
    encryptString(plain) {
      return Buffer.from([...plain].map((char) => char.charCodeAt(0) ^ key));
    },
    decryptString(encrypted) {
      return [...encrypted].map((byte) => String.fromCharCode(byte ^ key)).join("");
    },
  };
}

test("the safeStorage store round-trips, replaces, deletes — never plaintext on disk", async () => {
  const dir = workdir("hub-desktop-store-");
  try {
    const file = join(dir, "credentials.json");
    const store = new SafeStorageCredentialStore(fakeSafeStorage(), file);

    assert.equal(await store.load("pat"), null);
    await store.save("pat", "ghp_desktop_secret");
    assert.equal(await store.load("pat"), "ghp_desktop_secret");

    await store.save("confluence-token", "tok_desktop");
    assert.equal(await store.load("confluence-token"), "tok_desktop");

    const onDisk = readFileSync(file, "utf8");
    assert.ok(!onDisk.includes("ghp_desktop_secret"), "the secret never lands in plaintext");
    assert.ok(!onDisk.includes("tok_desktop"));
    assert.match(onDisk, /"pat"\s*:\s*"[A-Za-z0-9+/=]+"/, "base64 blobs instead");

    await store.save("pat", "ghp_rotated");
    assert.equal(await store.load("pat"), "ghp_rotated", "replace, not append");

    await store.delete("pat");
    assert.equal(await store.load("pat"), null);
    assert.equal(await store.load("confluence-token"), "tok_desktop", "sibling secrets survive");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an undecryptable blob reads as null — a changed keychain key loses nothing silently", async () => {
  const dir = workdir("hub-desktop-store2-");
  try {
    const file = join(dir, "credentials.json");
    const first = new SafeStorageCredentialStore(fakeSafeStorage(), file);
    await first.save("pat", "ghp_secret");

    // 다른 키로 생긴 저장소가 같은 파일을 읽는 상황.
    const otherKey = fakeSafeStorage();
    otherKey.decryptString = () => {
      throw new Error("could not decrypt");
    };
    const second = new SafeStorageCredentialStore(otherKey, file);
    assert.equal(await second.load("pat"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// bundled-runtime PATH prefix (daemon side, used by the desktop)
// ---------------------------------------------------------------------------

test("DRAFTHOUSE_EXTRA_PATH is prepended to PATH without duplicates", () => {
  const env = { PATH: "/usr/bin:/bin:/usr/local/bin" };
  assert.equal(extraPathPrefix("/Applications/Drafthouse.app/Contents/Resources/bin", env), [
    "/Applications/Drafthouse.app/Contents/Resources/bin",
    "/usr/bin",
    "/bin",
    "/usr/local/bin",
  ].join(":"));

  // 같은 경로가 이미 있으면 앞으로 옮기기만 한다(중복 없음).
  assert.equal(
    extraPathPrefix("/usr/bin", env),
    ["/usr/bin", "/bin", "/usr/local/bin"].join(":"),
  );

  assert.equal(extraPathPrefix(undefined, env), "/usr/bin:/bin:/usr/local/bin");
  assert.equal(extraPathPrefix("   ", env), "/usr/bin:/bin:/usr/local/bin");

  // Windows 구분자 — 플랫폼은 파라미터로(mac 에서 win32 분기 검증).
  const win = { PATH: "C:\\Windows;C:\\Program Files\\nodejs" };
  assert.equal(
    extraPathPrefix("C:\\Apps\\Drafthouse\\resources\\bin", win, "win32"),
    ["C:\\Apps\\Drafthouse\\resources\\bin", "C:\\Windows", "C:\\Program Files\\nodejs"].join(";"),
  );
});
