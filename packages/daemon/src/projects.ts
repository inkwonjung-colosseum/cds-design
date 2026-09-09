/**
 * Projects (PLAN D3/D4): one project is a Confluence subtree set plus one
 * connected repo. It is the unit everything else is scoped to — the mirror
 * that gets cloned, the clone Claude edits, the preview server that runs, and
 * (because the Agent SDK stores transcripts per directory) the session list.
 *
 * Layout, one folder per project:
 *
 *   ~/drafthouse/config/projects.json
 *   ~/drafthouse/projects/<slug>/confluence/<space>/   the mirrored subtree
 *   ~/drafthouse/projects/<slug>/repo/                 the clone
 *
 * The mirror lives inside the project rather than in one shared folder on
 * purpose: a project owns a SUBTREE of a space, the mirror is flat
 * (`<space>/<title>.md`, hierarchy in frontmatter), and a subtree cannot be
 * carved out of a flat folder by a symlink. Giving each project its own mirror
 * is what keeps a planning session's cwd free of other products' 기획서 — and
 * the containment-based write policy honest.
 *
 * The price is that one page must never live in two mirrors, or the optimistic
 * lock (`.confluence-sync.json` per mirror) splits in two and conflict
 * detection silently stops working. `findOverlap` is the rule that prevents
 * it, and it is the only invariant this module enforces.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HandoffStatus } from "@drafthouse/protocol";
import { CONFIG_DIR, DRAFTHOUSE_DIR } from "./environment.js";

/**
 * One Confluence subtree a project owns.
 *
 * `rootPageId: null` means the whole space. That is what a mirror cloned
 * before projects existed becomes on migration, and it stays a legitimate
 * choice for a team whose space holds exactly one product.
 *
 * `ancestorIds` is the root page's ancestor chain as Confluence reported it
 * when the project was created. It is stored rather than re-fetched because
 * overlap has to be decidable offline, in both directions, without walking a
 * remote tree: two subtrees collide exactly when one root is the other's
 * ancestor, and each side already knows its own ancestors.
 */
export interface ProjectRoot {
  /** Space key, e.g. `PROD`. */
  space: string;
  /** Root page id, or `null` for the whole space. */
  rootPageId: string | null;
  /** The root page's title (the space name when the root is the space). */
  title: string;
  /** Ancestor page ids of `rootPageId`, outermost first. Empty for a space. */
  ancestorIds: string[];
}

export interface ProjectRepo {
  url: string | null;
  /** What a handoff PR targets (PLAN D5). `main` unless the repo says otherwise. */
  baseBranch: string;
  /**
   * The open work cycle (PLAN D5): the branch 저장 pushes to and the pull
   * request a developer received. It lives in the registry rather than in the
   * clone because a re-clone must not lose track of a PR somebody is already
   * reviewing, and because the UI has to show 넘김/반영됨 before the repo
   * workspace has finished starting.
   */
  branch: string | null;
  handoff: HandoffStatus | null;
}

export interface Project {
  /** Stable id: folder name, credential-store item suffix, wire identity. */
  slug: string;
  /** What the planner named it. Korean is normal here. */
  name: string;
  roots: ProjectRoot[];
  repo: ProjectRepo;
}

/** Every path a project owns. */
export interface ProjectPaths {
  /** `~/drafthouse/projects/<slug>` */
  root: string;
  /** The connected repo's clone. */
  repoRoot: string;
  /** The mirror root; spaces are folders under it. */
  mirrorRoot: string;
}

interface ProjectsFile {
  active: string | null;
  projects: Project[];
}

export const DEFAULT_BASE_BRANCH = "main";

/** The slug a pre-projects installation migrates into. */
export const LEGACY_SLUG = "default";

/** `DRAFTHOUSE_PROJECTS_SETTINGS` points a test at a throwaway registry. */
export function projectsFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.DRAFTHOUSE_PROJECTS_SETTINGS ?? join(CONFIG_DIR, "projects.json");
}

export function projectsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.DRAFTHOUSE_PROJECTS_DIR ?? join(DRAFTHOUSE_DIR, "projects");
}

/** The credential-store item holding a project's repo PAT. */
export function repoPatItem(slug: string): string {
  return `pat:${slug}`;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * A folder- and item-safe id derived from the name.
 *
 * Only path-hostile characters are removed — the same set the mirror's own
 * page filenames drop — because the slug becomes a directory a human will one
 * day stare at, and `~/drafthouse/projects/결제/` is findable where
 * `project-2` is not. Every filesystem this ships on stores UTF-8 names, and
 * the mirror already writes `회원 관리 기획서.md` next door.
 *
 * Uniqueness is the caller's set of taken slugs.
 */
export function slugify(name: string, taken: ReadonlySet<string>): string {
  const base =
    name
      .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, "")
      .replace(/^\.+/, "")
      .trim()
      .replace(/\s+/g, "-")
      .toLowerCase()
      .slice(0, 32) || "project";
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * The project whose subtree would share pages with `candidate`, or null.
 *
 * Collision in the same space is any of: the same root page, a whole-space
 * root on either side, or one root sitting in the other's ancestor chain.
 * `ignoreSlug` lets a project be edited without colliding with itself.
 */
export function findOverlap(
  projects: readonly Project[],
  candidate: Pick<ProjectRoot, "space" | "rootPageId" | "ancestorIds">,
  ignoreSlug?: string,
): { slug: string; name: string; title: string } | null {
  for (const project of projects) {
    if (project.slug === ignoreSlug) continue;
    for (const root of project.roots) {
      if (root.space !== candidate.space) continue;
      // A whole-space root contains every page in it, in either direction.
      const collides =
        root.rootPageId === null ||
        candidate.rootPageId === null ||
        root.rootPageId === candidate.rootPageId ||
        candidate.ancestorIds.includes(root.rootPageId) ||
        root.ancestorIds.includes(candidate.rootPageId);
      if (collides) return { slug: project.slug, name: project.name, title: root.title };
    }
  }
  return null;
}

/**
 * Refuses a set of roots that would share pages with an existing project.
 * Every root is checked before anything is created, so a rejected project has
 * touched neither disk nor Confluence.
 */
export function assertNoOverlap(
  projects: readonly Project[],
  roots: readonly ProjectRoot[],
  ignoreSlug?: string,
): void {
  for (const root of roots) {
    const hit = findOverlap(projects, root, ignoreSlug);
    if (!hit) continue;
    throw new Error(
      `'${hit.name}' 프로젝트가 이미 이 페이지를 포함합니다 (${hit.title}) — 겹치지 않는 상위 페이지를 골라 주세요.`,
    );
  }
}

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function parseRoot(raw: unknown): ProjectRoot | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const space = cleanString(value.space);
  if (!space) return null;
  return {
    space,
    rootPageId: cleanString(value.rootPageId),
    title: cleanString(value.title) ?? space,
    ancestorIds: Array.isArray(value.ancestorIds)
      ? value.ancestorIds.filter((id): id is string => typeof id === "string")
      : [],
  };
}

const HANDOFF_STATES: Record<string, true> = {
  open: true,
  changes_requested: true,
  merged: true,
  closed: true,
};

function parseHandoff(raw: unknown): HandoffStatus | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const state = cleanString(value.state);
  const url = cleanString(value.url);
  const branch = cleanString(value.branch);
  if (typeof value.number !== "number" || !url || !branch || !state || !HANDOFF_STATES[state]) {
    return null;
  }
  return {
    number: value.number,
    url,
    branch,
    state: state as HandoffStatus["state"],
    title: cleanString(value.title) ?? "",
    pageIds: Array.isArray(value.pageIds)
      ? value.pageIds.filter((id): id is string => typeof id === "string")
      : [],
  };
}

function parseProject(raw: unknown): Project | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const slug = cleanString(value.slug);
  if (!slug) return null;
  const repo = (value.repo ?? {}) as Record<string, unknown>;
  const roots = Array.isArray(value.roots)
    ? value.roots.map(parseRoot).filter((root): root is ProjectRoot => root !== null)
    : [];
  return {
    slug,
    name: cleanString(value.name) ?? slug,
    roots,
    repo: {
      url: cleanString(repo.url),
      baseBranch: cleanString(repo.baseBranch) ?? DEFAULT_BASE_BRANCH,
      branch: cleanString(repo.branch),
      // A handoff is echoed back as the daemon wrote it. A hand edit that
      // breaks its shape reads as "no open handoff", which is recoverable —
      // 넘기기 simply opens a new pull request.
      handoff: parseHandoff(repo.handoff),
    },
  };
}

/** Reads the registry file, tolerating anything a hand edit could do to it. */
export function loadProjectsFile(env: NodeJS.ProcessEnv = process.env): ProjectsFile {
  try {
    const parsed = JSON.parse(readFileSync(projectsFile(env), "utf8")) as Record<string, unknown>;
    const projects = Array.isArray(parsed.projects)
      ? parsed.projects.map(parseProject).filter((project): project is Project => project !== null)
      : [];
    const active = cleanString(parsed.active);
    return {
      projects,
      active: active && projects.some((project) => project.slug === active) ? active : (projects[0]?.slug ?? null),
    };
  } catch {
    return { active: null, projects: [] };
  }
}

function saveProjectsFile(file: ProjectsFile, env: NodeJS.ProcessEnv = process.env): void {
  const path = projectsFile(env);
  mkdirSync(dirname(path), { recursive: true });
  // No secrets live here (the PAT is in the OS store), but the repo urls are
  // still the user's business: same private mode, same atomic replace as the
  // other settings files.
  const temporary = `${path}.drafthouse-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * The loaded registry: the list, which one is active, and where each one's
 * files are. Every mutation persists immediately — a daemon that dies between
 * a clone and a save would otherwise leave a folder nobody claims.
 */
export class ProjectRegistry {
  private file: ProjectsFile;

  private constructor(
    private readonly env: NodeJS.ProcessEnv,
    file: ProjectsFile,
  ) {
    this.file = file;
  }

  /**
   * Loads the registry, migrating a pre-projects installation on the way in.
   * `mirroredSpaces` is what the legacy mirror root actually holds; passing it
   * keeps this module free of the sync engine.
   */
  static load(env: NodeJS.ProcessEnv = process.env, mirroredSpaces: readonly string[] = []): ProjectRegistry {
    const loaded = loadProjectsFile(env);
    if (loaded.projects.length > 0) return new ProjectRegistry(env, loaded);
    const migrated = migrateLegacyLayout(env, mirroredSpaces);
    if (migrated) {
      saveProjectsFile(migrated, env);
      return new ProjectRegistry(env, migrated);
    }
    return new ProjectRegistry(env, loaded);
  }

  list(): Project[] {
    return this.file.projects;
  }

  get(slug: string): Project | null {
    return this.file.projects.find((project) => project.slug === slug) ?? null;
  }

  activeSlug(): string | null {
    return this.file.active;
  }

  active(): Project | null {
    return this.file.active ? this.get(this.file.active) : null;
  }

  setActive(slug: string): Project {
    const project = this.get(slug);
    if (!project) throw new Error(`프로젝트를 찾을 수 없습니다: ${slug}`);
    this.file.active = slug;
    this.save();
    return project;
  }

  /**
   * Registers a new project. Every root is checked against every existing one
   * first, so a rejected creation has touched neither disk nor Confluence.
   */
  create(input: { name: string; roots: ProjectRoot[]; repoUrl: string | null; baseBranch?: string }): Project {
    const name = input.name.trim();
    if (!name) throw new Error("프로젝트 이름을 입력해 주세요");
    if (input.roots.length === 0) throw new Error("기획서가 있는 Confluence 위치를 하나 이상 골라 주세요");
    assertNoOverlap(this.file.projects, input.roots);
    const slug = slugify(name, new Set(this.file.projects.map((project) => project.slug)));
    const project: Project = {
      slug,
      name,
      roots: input.roots,
      repo: {
        url: input.repoUrl,
        baseBranch: input.baseBranch?.trim() || DEFAULT_BASE_BRANCH,
        branch: null,
        handoff: null,
      },
    };
    this.file.projects.push(project);
    // The first project is the active one; nothing else could be.
    this.file.active ??= slug;
    this.save();
    return project;
  }

  /** Changes what a project points at. Roots are replaced wholesale when given. */
  update(
    slug: string,
    changes: { name?: string; roots?: ProjectRoot[]; repoUrl?: string | null; baseBranch?: string },
  ): Project {
    const project = this.get(slug);
    if (!project) throw new Error(`프로젝트를 찾을 수 없습니다: ${slug}`);
    if (changes.roots) {
      assertNoOverlap(this.file.projects, changes.roots, slug);
      project.roots = changes.roots;
    }
    if (changes.name !== undefined) {
      const name = changes.name.trim();
      if (!name) throw new Error("프로젝트 이름을 입력해 주세요");
      project.name = name;
    }
    if (changes.repoUrl !== undefined) project.repo.url = changes.repoUrl;
    if (changes.baseBranch !== undefined) {
      project.repo.baseBranch = changes.baseBranch.trim() || DEFAULT_BASE_BRANCH;
    }
    this.save();
    return project;
  }

  /**
   * Forgets a project. Its folder stays on disk unless asked otherwise — a
   * mis-click must not take a mirror with unpushed 기획서 with it.
   */
  remove(slug: string): void {
    const index = this.file.projects.findIndex((project) => project.slug === slug);
    if (index < 0) throw new Error(`프로젝트를 찾을 수 없습니다: ${slug}`);
    this.file.projects.splice(index, 1);
    if (this.file.active === slug) this.file.active = this.file.projects[0]?.slug ?? null;
    this.save();
  }

  /**
   * Where a project's files live.
   *
   * `DRAFTHOUSE_REPO_DIR` / `DRAFTHOUSE_CONFLUENCE_DIR` override the ACTIVE
   * project's two roots and nothing else. That is how the offline suites keep
   * driving fixture remotes and fixture mirrors: they run one project, it is
   * the active one, and the paths they prepared are the paths it uses.
   */
  paths(slug: string): ProjectPaths {
    const root = join(projectsRoot(this.env), slug);
    const activeOverride = slug === this.file.active;
    const repoOverride = activeOverride ? this.env.DRAFTHOUSE_REPO_DIR : undefined;
    const mirrorOverride = activeOverride ? this.env.DRAFTHOUSE_CONFLUENCE_DIR : undefined;
    return {
      root,
      repoRoot: repoOverride ?? join(root, "repo"),
      mirrorRoot: mirrorOverride ?? join(root, "confluence"),
    };
  }

  /**
   * The remote the active project's workspace should actually talk to.
   *
   * `DRAFTHOUSE_REPO_URL` wins over the registry for the ACTIVE project, the
   * same rule the two path overrides follow. It is how the offline suites
   * point a project at a fixture remote — and it has to be applied HERE rather
   * than written into the registry, because the registry is what `update()`
   * persists and a test's fixture url must never survive into a real config.
   */
  resolvedRepo(slug: string): ProjectRepo {
    const project = this.get(slug);
    if (!project) throw new Error(`프로젝트를 찾을 수 없습니다: ${slug}`);
    const override = slug === this.file.active ? cleanString(this.env.DRAFTHOUSE_REPO_URL) : null;
    return override ? { ...project.repo, url: override } : project.repo;
  }

  /**
   * Records where a project's work cycle stands. Called by the repo workspace
   * whenever a branch is created or a pull request moves — the registry is
   * the only thing that survives a restart, and a re-clone must not lose track
   * of a PR somebody is already reviewing.
   */
  setCycle(slug: string, cycle: { branch: string | null; handoff: HandoffStatus | null }): void {
    const project = this.get(slug);
    if (!project) return;
    project.repo.branch = cycle.branch;
    project.repo.handoff = cycle.handoff;
    this.save();
  }

  /** Creates the project's folders; callers clone into them. */
  ensureDirs(slug: string): ProjectPaths {
    const paths = this.paths(slug);
    mkdirSync(paths.mirrorRoot, { recursive: true });
    mkdirSync(dirname(paths.repoRoot), { recursive: true });
    return paths;
  }

  private save(): void {
    saveProjectsFile(this.file, this.env);
  }
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

/**
 * Turns a pre-projects installation into the single project it always was.
 *
 * Two shapes arrive here. A real installation has `~/drafthouse/repo` and
 * `~/drafthouse/confluence`, and those folders MOVE into
 * `projects/default/`. A test (or a dev pointing the daemon at scratch dirs)
 * has `DRAFTHOUSE_REPO_DIR` / `DRAFTHOUSE_CONFLUENCE_DIR` set, and nothing
 * moves at all: `paths()` keeps handing the active project exactly those
 * directories.
 *
 * Migration reads only sources in the SAME configuration scope as the
 * registry it is filling. A run that redirected the registry
 * (`DRAFTHOUSE_PROJECTS_SETTINGS`, which every offline suite sets) must not
 * inherit the developer's real `~/drafthouse` — that once produced a scratch
 * daemon that warm-started a clone of the developer's own remote and reported
 * a project nobody in that run had created.
 *
 * Returns null when there is nothing to migrate, which is what a genuinely
 * first run looks like.
 */
export function migrateLegacyLayout(
  env: NodeJS.ProcessEnv,
  mirroredSpaces: readonly string[],
): ProjectsFile | null {
  const scoped = env.DRAFTHOUSE_PROJECTS_SETTINGS !== undefined || env.DRAFTHOUSE_PROJECTS_DIR !== undefined;
  const legacyRepo = env.DRAFTHOUSE_REPO_DIR ?? (scoped ? null : join(DRAFTHOUSE_DIR, "repo"));
  const legacyMirror = env.DRAFTHOUSE_CONFLUENCE_DIR ?? (scoped ? null : join(DRAFTHOUSE_DIR, "confluence"));
  const repoUrl = env.DRAFTHOUSE_REPO_URL ?? legacyRepoUrl(env, scoped);
  const spaces =
    mirroredSpaces.length > 0 ? mirroredSpaces : legacyMirror ? readMirroredSpaces(legacyMirror) : [];

  const hasRepo = (legacyRepo !== null && existsSync(legacyRepo)) || repoUrl !== null;
  if (!hasRepo && spaces.length === 0) return null;

  const target = join(projectsRoot(env), LEGACY_SLUG);
  // With the env overrides in play the legacy paths ARE the project's paths;
  // moving them would break the very run that set them.
  if (!env.DRAFTHOUSE_REPO_DIR && legacyRepo && existsSync(legacyRepo)) {
    moveInto(legacyRepo, join(target, "repo"));
  }
  if (!env.DRAFTHOUSE_CONFLUENCE_DIR && legacyMirror && existsSync(legacyMirror)) {
    moveInto(legacyMirror, join(target, "confluence"));
  }

  return {
    active: LEGACY_SLUG,
    projects: [
      {
        slug: LEGACY_SLUG,
        name: "내 프로젝트",
        // A pre-projects mirror is whole-space by construction: there was no
        // way to mirror less. `rootPageId: null` says exactly that.
        roots: spaces.map((space) => ({ space, rootPageId: null, title: space, ancestorIds: [] })),
        repo: { url: repoUrl, baseBranch: DEFAULT_BASE_BRANCH, branch: null, handoff: null },
      },
    ],
  };
}

/** The url the old single-repo settings file held, if it still exists. */
function legacyRepoUrl(env: NodeJS.ProcessEnv, scoped: boolean): string | null {
  const file = env.DRAFTHOUSE_REPO_SETTINGS ?? (scoped ? null : join(CONFIG_DIR, "repo.json"));
  if (!file) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    return cleanString(parsed.url);
  } catch {
    return null;
  }
}

/** Space folders in a mirror root: a folder holding the sync sidecar. */
function readMirroredSpaces(mirrorRoot: string): string[] {
  if (!existsSync(mirrorRoot)) return [];
  try {
    return readdirSync(mirrorRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(mirrorRoot, entry.name, ".confluence-sync.json")))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * Moves a legacy folder under the project. A rename across devices fails on
 * some setups (a home directory on a different volume than a symlinked
 * `~/drafthouse`); there the migration is skipped rather than half-copied, and
 * the project starts empty — a re-clone, not a loss, because both folders are
 * reproducible from their remotes.
 */
function moveInto(from: string, to: string): void {
  if (existsSync(to)) return;
  try {
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
  } catch {
    // Left in place; the project re-clones on first use.
  }
}
