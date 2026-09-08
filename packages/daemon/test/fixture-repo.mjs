/**
 * A local fixture "connected repo": a bare git remote plus a seed commit
 * carrying a minimal but valid drafthouse app — package.json with no-op
 * install/check scripts, a tiny node static server as the preview, and a
 * drafthouse.json that declares the preview command and a free port picked at
 * seed time. Everything runs offline: git remotes are local paths, commands
 * are node/npm, and no registry is contacted.
 *
 * Shared by the daemon repo e2e and the browser planner e2e so both boot the
 * exact same repo contract.
 */
import { execFile } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** A port nothing is listening on, for the fixture preview to declare. */
export function freePort() {
  const { promise, resolve } = Promise.withResolvers();
  const server = createServer();
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
  return promise;
}

const SERVER_MJS = `import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const { preview } = JSON.parse(readFileSync(join(root, "drafthouse.json"), "utf8"));

createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(readFileSync(join(root, "index.html"), "utf8"));
}).listen(preview.port, "127.0.0.1", () => {
  console.log(\`fixture preview on http://127.0.0.1:\${preview.port}\`);
});
`;

const INDEX_HTML = `<!doctype html>
<html lang="ko">
<head><meta charset="utf-8"><title>연결 레포 미리보기</title></head>
<body>
  <main id="app">
    <h1>회원 관리</h1>
    <p>연결 레포가 렌더하는 미리보기입니다.</p>
  </main>
</body>
</html>
`;

const PACKAGE_JSON = JSON.stringify(
  {
    name: "fixture-drafthouse-app",
    private: true,
    version: "0.0.0",
    scripts: {
      install: 'node -e ""',
      check: 'node -e ""',
    },
  },
  null,
  2,
);

// The repo's own convention for where screens live. The daemon does not know
// this; the browser planner e2e relies on it, the daemon e2e does not.
const CLAUDE_MD = `# fixture drafthouse 레포

**대화 상대는 기획자다.** 모든 문장은 한국어로 쓴다.

## 작업 절차

- 화면 요청이 오면 \`src/screens/<기능>/<화면이름>.screen.tsx\` 형태로 파일을 만든다.
- 기획서에 없는 것은 지어내지 않고 AskUserQuestion으로 한 번에 묻는다.
- 터미널 명령은 실행하지 않는다. 미리보기 서버는 이미 돌고 있다.
- 만들거나 바꾼 화면을 이름과 경로로 답변에 남긴다.
`;

/**
 * Creates the remote and pushes the seed commit.
 *
 * `overrides.previewCommand` swaps what `preview.command` runs (unit tests use
 * a command that exits immediately to observe the failure phases).
 */
export async function createFixtureRepo({
  dir,
  port,
  previewCommand = "node server.mjs",
  installCommand = "npm run install",
}) {
  const seed = join(dir, "seed");
  const remote = join(dir, "remote.git");

  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(seed, "src", "screens"), { recursive: true });

  writeFileSync(
    join(seed, "drafthouse.json"),
    JSON.stringify(
      {
        install: installCommand,
        check: "npm run check",
        preview: { command: previewCommand, port },
      },
      null,
      2,
    ),
  );
  writeFileSync(join(seed, "package.json"), PACKAGE_JSON);
  writeFileSync(join(seed, "server.mjs"), SERVER_MJS);
  writeFileSync(join(seed, "index.html"), INDEX_HTML);
  writeFileSync(join(seed, "CLAUDE.md"), CLAUDE_MD);

  await run("git", ["init", "--initial-branch=main", seed]);
  await commitAll(seed, "seed");
  await run("git", ["init", "--bare", "--initial-branch=main", remote]);
  await run("git", ["push", remote, "HEAD:main"], { cwd: seed });

  return { dir, seed, remote, port };
}

/** Writes `files` (path -> contents, relative to the seed root), commits, pushes. */
export async function pushFixtureChange(seed, remote, files, message = "update") {
  for (const [path, contents] of Object.entries(files)) {
    const file = join(seed, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents);
  }
  await commitAll(seed, message);
  await run("git", ["push", remote, "HEAD:main"], { cwd: seed });
}

async function commitAll(seed, message) {
  await run("git", ["add", "."], { cwd: seed });
  await run(
    "git",
    ["-c", "user.name=drafthouse", "-c", "user.email=fixture@drafthouse.test", "commit", "-m", message],
    { cwd: seed },
  );
}
