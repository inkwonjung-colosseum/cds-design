/**
 * Enforces the screen file contract so a developer can lift a feature folder
 * into the real app without untangling it.
 *
 *   node scripts/check-screens.mjs                 # check src/screens
 *   node scripts/check-screens.mjs --json          # machine-readable screen list
 *   node scripts/check-screens.mjs --root <dir>    # check some other tree
 *   node scripts/check-screens.mjs --self-test     # prove the rules still fire
 *
 * Every failure names the file, the rule, and the fix. The agent writing
 * screens reads these messages, so vague ones cost a round trip.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const ALLOWED_PACKAGES = ["react", "react-dom", "@colosseumcoinckr/"];
/** Utility prefixes whose value comes from the `--color-*` namespace. */
const COLOR_UTILITIES = [
  "bg",
  "text",
  "border",
  "ring",
  "fill",
  "stroke",
  "divide",
  "outline",
  "shadow",
  "decoration",
  "caret",
  "accent",
  "placeholder",
  "from",
  "to",
  "via",
];
/** Token families a screen may reference. Anything else is app-invented. */
const TOKEN_FAMILIES = [
  "background-",
  "text-",
  "borders-",
  "icon-",
  "clblue-",
  "gray-",
  "natural-",
  "red-",
  "green-",
  "yellow-",
  "orange-",
  "purple-",
  "sky-",
  "primary-",
];

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/**
 * Color tokens Tailwind can resolve, read from the installed packages. Without
 * `node_modules` there is nothing to compare against, so token checking is
 * skipped rather than guessed.
 */
function readColorTokens(root) {
  const sources = [
    join(root, "node_modules/@colosseumcoinckr/cds/src/styles/globals.css"),
    ...walk(join(root, "node_modules/.pnpm")).filter((file) =>
      file.endsWith(join("@colosseumcoinckr", "tokens", "tailwind.css")),
    ),
  ].filter(existsSync);
  if (sources.length === 0) return null;
  const tokens = new Set();
  for (const source of sources) {
    for (const match of readFileSync(source, "utf8").matchAll(/--color-([a-z0-9-]+)\s*:/g)) {
      tokens.add(match[1]);
    }
  }
  return tokens;
}

/** `export const meta = { … }` up to its closing brace at column 0. */
export function parseMeta(source) {
  const start = source.match(/export\s+const\s+meta\s*(?::[^=]+)?=\s*\{/);
  if (!start) return null;
  const from = start.index + start[0].length - 1;
  let depth = 0;
  let end = -1;
  for (let i = from; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return null;
  const body = source.slice(from, end + 1);
  const title = body.match(/title\s*:\s*['"`](.+?)['"`]/);
  const spec = body.match(/spec\s*:\s*['"`](.+?)['"`]/);
  const frame = body.match(/frame\s*:\s*['"`](admin|none)['"`]/);
  const states = body.match(/states\s*:\s*\[([^\]]*)\]/);
  return {
    title: title?.[1] ?? null,
    spec: spec?.[1] ?? null,
    frame: frame?.[1] ?? null,
    states: states
      ? [...states[1].matchAll(/['"`]([^'"`]+)['"`]/g)].map((match) => match[1])
      : null,
    hasStatesKey: Boolean(states),
  };
}

function checkScreen(file, root, tokens) {
  const source = readFileSync(file, "utf8");
  const id = relative(join(root, "src/screens"), file)
    .split(sep)
    .join("/")
    .replace(/\.screen\.tsx$/, "");
  const problems = [];
  const fail = (rule, fix) => problems.push({ file: relative(root, file), rule, fix });

  for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
    const source_ = match[1];
    const isRelativeSibling = /^\.\/[^/]+$/.test(source_);
    const allowed =
      isRelativeSibling || ALLOWED_PACKAGES.some((prefix) => source_.startsWith(prefix));
    if (!allowed) {
      fail(
        `import "${source_}" is not allowed`,
        "a screen may import react, @colosseumcoinckr/*, and files next to it — copy what you need into this folder",
      );
    }
    if (source_.endsWith(".css")) {
      fail("imports a stylesheet", "style with CDS component props and token classes instead");
    }
    if (source_ === "@colosseumcoinckr/cds") {
      fail(
        "imports the cds root barrel, which does not exist",
        'use a subpath: @colosseumcoinckr/cds/components/button',
      );
    }
  }

  const meta = parseMeta(source);
  if (!meta) {
    fail(
      "has no `export const meta`",
      'add: export const meta = { title: "화면 이름", states: ["default"] }',
    );
  } else {
    if (!meta.title) fail("meta has no string `title`", 'add title: "화면 이름"');
    if (meta.hasStatesKey && (meta.states === null || meta.states.length === 0)) {
      fail("meta.states is empty", 'list the variants: states: ["default", "empty"]');
    }
    if (meta.states && !/\bstate\b/.test(source.slice(0, source.indexOf("return")))) {
      fail(
        "declares meta.states but never reads the `state` prop",
        'accept it: export default function Screen({ state = "default" }: { state?: string })',
      );
    }
  }

  if (!/export\s+default\s+function/.test(source)) {
    fail("has no default exported component", "export default function <Name>Screen() { … }");
  }

  for (const match of source.matchAll(/#[0-9a-fA-F]{3,8}\b|\brgba?\(/g)) {
    fail(
      `hard-codes the color \`${match[0]}\``,
      "use a CDS token class (bg-background-*, text-text-*, border-borders-*) or a component variant",
    );
  }
  for (const match of source.matchAll(
    new RegExp(`\\b(?:${COLOR_UTILITIES.join("|")})-\\[[^\\]]+\\]`, "g"),
  )) {
    fail(
      `uses the arbitrary color value \`${match[0]}\``,
      "pick the nearest CDS token class instead",
    );
  }

  if (tokens) {
    const used = new Set();
    for (const match of source.matchAll(
      new RegExp(`\\b(?:${COLOR_UTILITIES.join("|")})-([a-z0-9-]+)`, "g"),
    )) {
      if (TOKEN_FAMILIES.some((family) => match[1].startsWith(family))) used.add(match[1]);
    }
    for (const token of used) {
      if (!tokens.has(token)) {
        fail(
          `uses the unknown token \`${token}\``,
          "no --color-" +
            token +
            " exists; read node_modules/@colosseumcoinckr/cds/src/styles/globals.css for the real names",
        );
      }
    }
  }

  // Data belongs in the sibling mock file so a developer has one place to swap
  // in the API. Three or more object literals in a row is a data table.
  const objectArrays = source.matchAll(/\[\s*\{[\s\S]{0,4000}?\}\s*\]/g);
  for (const match of objectArrays) {
    if ((match[0].match(/\{/g) ?? []).length >= 3) {
      fail(
        "holds a data table inline",
        `move it to ${id.slice(id.lastIndexOf("/") + 1)}.mock.ts and import it`,
      );
      break;
    }
  }

  return { id, meta, problems, source };
}

export function checkTree(root, tokenRoot = root) {
  const screensDir = join(root, "src/screens");
  const files = walk(screensDir).filter((file) => file.endsWith(".screen.tsx"));
  const tokens = readColorTokens(tokenRoot);
  const results = files.map((file) => checkScreen(file, root, tokens));
  const problems = results.flatMap((result) => result.problems);

  const features = new Set(
    results.map((result) => (result.id.includes("/") ? result.id.split("/")[0] : "_root")),
  );
  for (const feature of features) {
    if (feature !== "_root" && !existsSync(join(screensDir, feature, "HANDOFF.md"))) {
      problems.push({
        file: `src/screens/${feature}/`,
        rule: "has no HANDOFF.md",
        fix: "write one so a developer knows which screens exist, which components they use, and what is still undecided",
      });
    }
  }

  return { results, problems, tokensChecked: tokens !== null };
}

function selfTest() {
  const fixtures = join(projectRoot, "scripts/fixtures");
  const cases = readdirSync(fixtures);
  let failed = 0;
  for (const name of cases) {
    const { problems } = checkTree(join(fixtures, name), projectRoot);
    const expected = name !== "clean";
    const fired = problems.length > 0;
    if (fired !== expected) {
      failed += 1;
      console.error(`FAIL ${name}: expected ${expected ? "problems" : "none"}, got ${problems.length}`);
    } else {
      console.log(`ok   ${name}${fired ? ` — ${problems[0].rule}` : ""}`);
    }
  }
  return failed === 0 ? 0 : 1;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) process.exit(selfTest());

  const rootFlag = args.indexOf("--root");
  const root = rootFlag === -1 ? projectRoot : resolve(args[rootFlag + 1]);
  const { results, problems, tokensChecked } = checkTree(root);

  if (args.includes("--json")) {
    console.log(
      JSON.stringify(
        results.map(({ id, meta }) => ({
          id,
          title: meta?.title ?? id.slice(id.lastIndexOf("/") + 1),
          states: meta?.states ?? [],
          frame: meta?.frame ?? "none",
        })),
        null,
        2,
      ),
    );
    process.exit(problems.length === 0 ? 0 : 1);
  }

  if (problems.length === 0) {
    console.log(
      `화면 ${results.length}개 규칙 통과${tokensChecked ? "" : " (토큰 검사 생략 — node_modules 없음)"}`,
    );
    process.exit(0);
  }

  console.error(`화면 규칙 위반 ${problems.length}건:\n`);
  for (const problem of problems) {
    console.error(`  ${problem.file}`);
    console.error(`    문제: ${problem.rule}`);
    console.error(`    수정: ${problem.fix}\n`);
  }
  process.exit(1);
}

// `node <path>` can reach this file through a symlinked directory — on macOS
// /var/folders resolves to /private/var/folders — and a plain string compare
// would then skip main() and exit 0, turning the gate into a silent no-op.
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return entry === fileURLToPath(import.meta.url);
  }
})();

if (invokedDirectly) main();
