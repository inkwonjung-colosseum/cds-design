/**
 * Per-space Confluence mirror engine (DESIGN §4.2/§4.4).
 *
 * Layout: `<root>/<spaceKey>/` holds one `.md` per page (frontmatter carries
 * pageId/version/space/title/parentPageId) and `attachments/<pageId>/<file>`
 * for that page's attachments. A `.confluence-sync.json` sidecar records, per
 * page, the version and content hash at last sync — that is what tells an
 * edit from a no-op, and what produces a real three-way conflict object.
 *
 * - clone: full-space initial copy (all pages + attachments).
 * - pull: fetch changed pages by version; a locally-edited page that also
 *   moved remotely becomes a conflict instead of being overwritten.
 * - push: upload edited pages with `version.number + 1`; a remote version ≠
 *   the recorded one BLOCKS the push and records a conflict. Attachment
 *   files whose content hash moved are uploaded (same filename → new
 *   version, i.e. replace).
 * - Deletion never happens, in either direction.
 * - Background pull defers while any deferral token is held (an unsaved
 *   editor buffer, a running Claude turn — wired up by later stories).
 */

import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DRAFTHOUSE_DIR } from "../environment.js";
import type { ConfluenceClient } from "./confluence-client.js";
import {
  markdownToStorage,
  parseFrontmatter,
  storageToMarkdown,
  type PageMeta,
} from "./storage-markdown.js";

// The wire types are the contract; the engine does not keep a second copy of
// them (a divergent duplicate is what let `pulledAt` typecheck here and fail
// at the server boundary).
export type {
  ConfluenceConflict,
  ConfluencePhase,
  ConfluenceReview,
  ConfluenceStatus,
  DocSummary,
} from "@drafthouse/protocol";
import type {
  ConfluenceConflict,
  ConfluencePhase,
  ConfluenceReview,
  ConfluenceStatus,
  DocSummary,
} from "@drafthouse/protocol";

export interface Deferral {
  readonly reason: string;
  release(): void;
}

interface PageState {
  file: string;
  version: number;
  /** sha256 of the markdown BODY (frontmatter excluded). */
  markdownHash: string;
  lastSyncedMarkdown: string;
}

interface MirrorState {
  spaceKey: string;
  spaceId: string;
  /**
   * The subtree this mirror is scoped to, recorded by clone so `pull` keeps
   * the same scope after a restart without being told again. Absent or
   * `null` in a whole-space mirror (and in every pre-projects one).
   */
  rootPageId?: string | null;
  pages: Record<string, PageState>;
  attachments: Record<string, { hash: string }>;
  /** Epoch ms of the last successful clone/pull. Absent in pre-existing mirrors. */
  pulledAt?: number;
}

const STATE_FILE = ".confluence-sync.json";

export function resolveConfluenceRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.DRAFTHOUSE_CONFLUENCE_DIR ?? join(DRAFTHOUSE_DIR, "confluence");
}

/**
 * A space's folder name inside the mirror. Personal Confluence spaces are
 * keyed `~<accountId>`, and a path component starting with `~` is read as a
 * home reference by the Claude CLI: it decides the file is outside the
 * session's own cwd and cards every Read of it, which makes a personal space
 * unusable. `~` is also the one character a shell would expand, so a command
 * naming the folder would miss it too.
 *
 * Confluence keys are otherwise alphanumeric, so a leading `_` cannot collide
 * with a real key and the mapping stays reversible by pure string work.
 */
export function mirrorDirName(spaceKey: string): string {
  return spaceKey.startsWith("~") ? `_${spaceKey.slice(1)}` : spaceKey;
}

/** The space key a mirror folder (or a mirror-relative path) belongs to. */
export function spaceKeyForDir(dir: string): string {
  return dir.startsWith("_") ? `~${dir.slice(1)}` : dir;
}

export class SyncEngine {
  private readonly statuses = new Map<string, ConfluenceStatus>();
  private readonly deferrals = new Set<Deferral>();
  private readonly inFlight = new Map<string, Promise<ConfluenceStatus>>();
  /** One timer per mirrored space; the daemon starts one for each. */
  private readonly backgroundTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly options: {
      root: string;
      clientFactory: () => ConfluenceClient | null;
      onStatus: (status: ConfluenceStatus) => void;
      /**
       * A page that existed only locally now exists in Confluence, and its
       * `new-…` placeholder has become a real id. Anything keyed by the old
       * one — the daemon's thread↔page sidecar — follows here, inside the
       * same push that rewrote the file.
       */
      onPageIdentified?: (previousPageId: string, pageId: string) => void;
    },
  ) {}

  // -- status ----------------------------------------------------------------


  spaces(): string[] {
    this.reconcileLegacyFolders();
    if (!existsSync(this.options.root)) return [];
    // A legacy and a canonical folder for one space collapse to the same key,
    // so the listing is deduped by key, not by folder.
    const seen = new Set<string>();
    const keys: string[] = [];
    for (const entry of readdirSync(this.options.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      if (!existsSync(join(this.options.root, entry.name, STATE_FILE))) continue;
      const space = spaceKeyForDir(entry.name);
      if (!seen.has(space)) {
        seen.add(space);
        keys.push(space);
      }
    }
    return keys;
  }

  /** Runs once per engine: a mirror from before the `_key` folder convention. */
  private reconciled = false;

  /**
   * Adopts mirrors written before the `~key` → `_key` folder convention
   * (`mirrorDirName`): a personal space could end up with BOTH spellings on
   * disk, and the tree then lists the same space twice with two diverging sync
   * states. The canonical folder wins; pages only the legacy folder holds are
   * copied into it first, and the legacy folder is renamed out of the listing
   * (dot-prefixed) — nothing here is ever deleted.
   */
  private reconcileLegacyFolders(): void {
    if (this.reconciled || !existsSync(this.options.root)) return;
    this.reconciled = true;
    for (const entry of readdirSync(this.options.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      if (!existsSync(join(this.options.root, entry.name, STATE_FILE))) continue;
      const canonical = mirrorDirName(spaceKeyForDir(entry.name));
      if (canonical === entry.name) continue;
      const legacyPath = join(this.options.root, entry.name);
      const canonicalPath = join(this.options.root, canonical);
      if (!existsSync(join(canonicalPath, STATE_FILE))) {
        renameSync(legacyPath, canonicalPath);
        continue;
      }
      this.adoptLegacyPages(canonicalPath, legacyPath);
      renameSync(legacyPath, join(this.options.root, `.legacy-${Date.now()}-${entry.name}`));
    }
  }

  /** Copies pages — and their attachments — that the canonical mirror lacks. */
  private adoptLegacyPages(canonicalPath: string, legacyPath: string): void {
    const read = (dir: string): MirrorState =>
      JSON.parse(readFileSync(join(dir, STATE_FILE), "utf8")) as MirrorState;
    const canonicalState = read(canonicalPath);
    const legacyState = read(legacyPath);
    let adopted = false;
    for (const [pageId, page] of Object.entries(legacyState.pages)) {
      if (canonicalState.pages[pageId]) continue;
      const from = join(legacyPath, page.file);
      const to = join(canonicalPath, page.file);
      // Same filename under a different id: the canonical copy wins, and the
      // legacy page stays only in the renamed folder.
      if (!existsSync(from) || existsSync(to)) continue;
      copyFileSync(from, to);
      canonicalState.pages[pageId] = page;
      const attachments = join(legacyPath, "attachments", pageId);
      if (existsSync(attachments)) {
        cpSync(attachments, join(canonicalPath, "attachments", pageId), { recursive: true });
      }
      for (const [key, record] of Object.entries(legacyState.attachments)) {
        if (key.startsWith(`${pageId}/`) && !canonicalState.attachments[key]) {
          canonicalState.attachments[key] = record;
        }
      }
      adopted = true;
    }
    if (!adopted) return;
    const temporary = join(canonicalPath, `${STATE_FILE}.adopt`);
    writeFileSync(temporary, `${JSON.stringify(canonicalState, null, 2)}\n`);
    renameSync(temporary, join(canonicalPath, STATE_FILE));
  }

  status(key: string): ConfluenceStatus {
    // Callers reach here with a doc path's folder name as often as with a
    // space key; one spelling has to win before anything is keyed by it.
    const space = spaceKeyForDir(key);
    const cached = this.statuses.get(space);
    if (cached) return cached;
    const state = this.readState(space);

    return {
      space,
      phase: "idle",
      pages: Object.keys(state?.pages ?? {}).length,
      detail: null,
      pulledAt: state?.pulledAt ?? null,
      conflicts: [],
    };
  }

  allStatuses(): ConfluenceStatus[] {
    return this.spaces().map((space) => this.status(space));
  }

  conflicts(space: string): ConfluenceConflict[] {
    return this.status(space).conflicts;
  }

  /**
   * The page tree of a mirrored space: every page this engine has synced,
   * plus every markdown file that exists locally but has never been pushed.
   * A planning session writes those (a brand-new 기획서), and the tree is the
   * only place the planner can see them before 게시 creates the remote page.
   */
  pageList(key: string): DocSummary[] {
    const spaceKey = spaceKeyForDir(key);
    const state = this.readState(spaceKey);
    if (!state) return [];
    // A doc path is resolved against the mirror root, so its first segment is
    // the folder's name, not the space's key - they differ for personal spaces.
    const dir = mirrorDirName(spaceKey);
    const conflicted = new Set(this.status(spaceKey).conflicts.map((conflict) => conflict.pageId));
    const pages: DocSummary[] = [];
    const tracked = new Set<string>();

    for (const [pageId, page] of Object.entries(state.pages)) {
      tracked.add(page.file);
      const file = join(this.mirror(spaceKey), page.file);
      let meta: Partial<PageMeta> = {};
      let modified = true;
      try {
        const markdown = readFileSync(file, "utf8");
        meta = parseFrontmatter(markdown).meta;
        modified = hash(bodyOf(markdown)) !== page.markdownHash;
      } catch {
        // A vanished file still shows in the tree; push/pull will surface it.
      }
      pages.push({
        path: `${dir}/${page.file}`,
        title: meta.title ?? page.file.replace(/\.md$/, ""),
        pageId,
        parentPageId: meta.parentPageId ?? null,
        version: page.version,
        modified,
        conflict: conflicted.has(pageId),
        isNew: false,
      });
    }

    for (const file of this.markdownFiles(spaceKey)) {
      if (tracked.has(file)) continue;
      const markdown = readFileSync(join(this.mirror(spaceKey), file), "utf8");
      const { meta } = parseFrontmatter(markdown);
      // Without a pageId there is nothing 게시 could create; the file is not
      // a page yet and must not be offered as one.
      if (!meta.pageId) continue;
      pages.push({
        path: `${dir}/${file}`,
        title: meta.title ?? file.replace(/\.md$/, ""),
        pageId: meta.pageId,
        parentPageId: meta.parentPageId ?? null,
        version: meta.version ?? 0,
        modified: true,
        conflict: false,
        isNew: true,
      });
    }

    return pages.sort((a, b) => a.title.localeCompare(b.title));
  }

  /**
   * Resolves a conflict: `theirs` overwrites the file with the remote
   * markdown; `mine` keeps the file as-is (hand-edited or not) and adopts the
   * remote version number, so the next push overwrites the remote instead of
   * colliding again.
   */
  async resolveConflict(
    key: string,
    pageId: string,
    choice: "mine" | "theirs",
  ): Promise<{ markdown: string; version: number }> {
    const spaceKey = spaceKeyForDir(key);
    const status = this.statuses.get(spaceKey);
    const conflict = status?.conflicts.find((entry) => entry.pageId === pageId);
    if (!conflict) throw new Error("해결할 충돌이 없습니다");

    const state = this.requireState(spaceKey);
    const known = state.pages[pageId];
    if (!known) throw new Error(`페이지 ${pageId} 을(를) 미러에서 찾을 수 없습니다`);
    const file = join(this.mirror(spaceKey), known.file);

    if (choice === "theirs") writeFileSync(file, conflict.theirs.markdown);
    const settled = withVersion(readFileSync(file, "utf8"), conflict.theirs.version, pageId);

    writeFileSync(file, settled);
    state.pages[pageId] = {
      file: known.file,
      version: conflict.theirs.version,
      // Keeping ours adopts the remote version number but stays "modified":
      // the empty hash marks the file as awaiting a push that overwrites the
      // remote, instead of silently considering it synced.
      markdownHash: choice === "mine" ? "" : hash(bodyOf(settled)),
      lastSyncedMarkdown: bodyOf(settled),
    };
    this.writeState(spaceKey, state);

    const remaining = (status?.conflicts ?? []).filter((entry) => entry.pageId !== pageId);
    this.emit(spaceKey, {
      phase: remaining.length > 0 ? "error" : "idle",
      detail: choice === "mine" ? "충돌을 내 것으로 해결했습니다" : "원격 버전을 받아 충돌을 해결했습니다",
      conflicts: remaining,
    });
    return { markdown: settled, version: conflict.theirs.version };
  }

  // -- operations --------------------------------------------------------------

  /**
   * Initial copy of a space, or of one page subtree within it, and the way
   * either is re-taken from scratch. A `rootPageId` scopes the mirror to that
   * page and its descendants (a project root); omitted, the whole space is
   * cloned, as it always was.
   *
   * The state file is written as the clone walks, exactly like `pull`: a
   * clone that dies on page 300 of 500 (a 429, a dropped connection, a
   * daemon restart) used to leave a folder full of markdown that no
   * `.confluence-sync.json` claimed — invisible to `spaces()`, so the tree
   * stayed empty, no background pull ran, and the only way out was to start
   * over. Written per page, the same interruption leaves a real, partial
   * mirror that the next clone or pull finishes.
   */
  clone(key: string, rootPageId?: string | null): Promise<ConfluenceStatus> {
    const spaceKey = spaceKeyForDir(key);
    return this.runExclusive(spaceKey, async () => {
      const client = this.requireClient();
      this.emit(spaceKey, { phase: "cloning", detail: null });

      const space = await client.findSpace(spaceKey);
      const root = rootPageId ?? null;
      const pages =
        root === null ? await client.listSpacePages(space.id) : await client.listSubtreePages(root);
      mkdirSync(this.mirror(spaceKey), { recursive: true });
      const state: MirrorState = {
        spaceKey,
        spaceId: space.id,
        // Recorded before the first page so an interrupted clone's mirror is
        // still scoped: the pull that finishes it must not widen to the space.
        rootPageId: root,
        pages: {},
        attachments: {},
      };
      // Claim the folder before the first page lands: an interrupted clone is
      // then a mirror with fewer pages, not an unowned pile of files.
      this.writeState(spaceKey, state);
      const taken = new Set<string>();
      const skipped: string[] = [];

      for (const page of pages) {
        const body = await client.getPage(page.id);
        const file = pageFileName(page.title, taken);
        const markdown = storageToMarkdown(
          body.storage,
          {
            pageId: page.id,
            version: body.version,
            space: spaceKey,
            title: body.title,
            parentPageId: page.parentId,
          },
          `attachments/${page.id}`,
        );
        writeFileSync(join(this.mirror(spaceKey), file), markdown);
        state.pages[page.id] = {
          file,
          version: body.version,
          markdownHash: hash(bodyOf(markdown)),
          lastSyncedMarkdown: bodyOf(markdown),
        };
        // Same per-page atomicity rule as pull: the page's state persists
        // before its attachments, so a failure in that window never leaves
        // the file ahead of the state that describes it.
        this.writeState(spaceKey, state);
        skipped.push(...(await this.downloadAttachments(client, spaceKey, page.id, state)));
        this.writeState(spaceKey, state);
        this.emit(spaceKey, { phase: "cloning", detail: `${page.title} 복제됨` });
      }

      const dropped = this.dropStaleMirrorFiles(spaceKey, state);
      state.pulledAt = Date.now();
      this.writeState(spaceKey, state);
      // Whose 복제 this was: the space, or the project root page by name —
      // "스페이스 ENG 복제 완료" for a subtree would name the wrong thing.
      const scope = root === null ? `스페이스 ${spaceKey}` : `${pages[0]?.title ?? root} 하위`;
      return this.emit(spaceKey, {
        phase: "idle",
        detail:
          `${scope} 복제 완료 — 페이지 ${pages.length}개` +
          (dropped > 0 ? ` · 오래된 파일 ${dropped}개 정리` : "") +
          // Named, not hidden: the planner sees a blank where an image was and
          // has to be able to tell "gone in Confluence" from "tool lost it".
          (skipped.length > 0 ? ` · 첨부 ${skipped.length}개 건너뜀 (${skipped[0]}${skipped.length > 1 ? " 외" : ""})` : ""),
      });
    });
  }

  /**
   * Removes page files a re-clone left behind: markdown this engine wrote
   * (frontmatter carries a pageId) for a page the space no longer lists, or
   * under a name a renamed page no longer uses. A file without a pageId is a
   * planner's unpublished draft and is never touched.
   */
  private dropStaleMirrorFiles(spaceKey: string, state: MirrorState): number {
    const live = new Set(Object.values(state.pages).map((page) => page.file));
    let dropped = 0;
    for (const file of this.markdownFiles(spaceKey)) {
      if (live.has(file)) continue;
      const path = join(this.mirror(spaceKey), file);
      const { meta } = parseFrontmatter(readFileSync(path, "utf8"));
      if (!meta.pageId) continue;
      rmSync(path, { force: true });
      dropped += 1;
    }
    return dropped;
  }

  /**
   * Update changed pages by version; never overwrite a locally-edited page.
   *
   * The scope comes off the state file, so a project's subtree mirror stays a
   * subtree mirror across restarts and background ticks without anyone
   * passing the root again.
   *
   * Same page set as `clone` — the root plus its transitive children — by a
   * deliberately different route. Clone pays once, so it walks the children
   * endpoint and never lists a 10k-page space to mirror twenty pages. Pull
   * pays on every background tick, so it takes the one paginated space
   * listing and narrows it here: that listing is also the only one carrying a
   * version per page, which is what lets the check below skip an unchanged
   * page without fetching its body. Walking children on every tick would
   * cost one body GET per page per minute, forever.
   *
   * A page that moved out of the subtree drops out of the narrowed listing —
   * the same thing a page deleted from a space does — and gets the same
   * treatment: its file and its recorded state stay put, because dropping a
   * page the planner may have edited is not this engine's call.
   */
  pull(key: string): Promise<ConfluenceStatus> {
    const spaceKey = spaceKeyForDir(key);
    return this.runExclusive(spaceKey, async () => {
      const client = this.requireClient();
      const state = this.requireState(spaceKey);
      this.emit(spaceKey, { phase: "pulling", detail: null });

      const listed = await client.listSpacePages(state.spaceId);
      const root = state.rootPageId ?? null;
      const parentOf = new Map(listed.map((page) => [page.id, page.parentId]));
      const pages =
        root === null
          ? listed
          : listed.filter((page) => {
              // Inside the subtree = the parent chain reaches the root. A
              // chain that leaves the listing is a page under someone else;
              // the seen-set is there because a remote move can leave the
              // listing's parent links in a cycle, and a spinning background
              // pull would be worse than a missed page.
              const walked = new Set<string>();
              let at: string | null = page.id;
              while (at !== null && !walked.has(at)) {
                if (at === root) return true;
                walked.add(at);
                at = parentOf.get(at) ?? null;
              }
              return false;
            });
      let updated = 0;
      const skipped: string[] = [];
      const conflicts: ConfluenceConflict[] = [];
      const taken = new Set(Object.values(state.pages).map((page) => page.file));

      for (const page of pages) {
        const known = state.pages[page.id];
        if (!known) {
          const body = await client.getPage(page.id);
          const file = pageFileName(page.title, taken);
          const markdown = storageToMarkdown(
            body.storage,
            {
              pageId: page.id,
              version: body.version,
              space: spaceKey,
              title: body.title,
              parentPageId: page.parentId,
            },
            `attachments/${page.id}`,
          );
          writeFileSync(join(this.mirror(spaceKey), file), markdown);
          state.pages[page.id] = {
            file,
            version: body.version,
            markdownHash: hash(bodyOf(markdown)),
            lastSyncedMarkdown: bodyOf(markdown),
          };
          // Per-page atomicity: the page's state persists BEFORE its
          // attachments download — a transport failure in that window must
          // not leave the file at the new version while the state remembers
          // the old one (that divergence manufactured phantom conflicts).
          this.writeState(spaceKey, state);
          skipped.push(...(await this.downloadAttachments(client, spaceKey, page.id, state)));
          this.writeState(spaceKey, state);
          updated += 1;
          continue;
        }

        if (page.version <= known.version) continue;

        const localFile = join(this.mirror(spaceKey), known.file);
        const localMarkdown = existsSync(localFile) ? readFileSync(localFile, "utf8") : "";
        const locallyEdited = hash(bodyOf(localMarkdown)) !== known.markdownHash;
        const remote = await client.getPage(page.id);

        if (locallyEdited) {
          conflicts.push({
            pageId: page.id,
            title: page.title,
            mine: { file: known.file, version: known.version, markdown: localMarkdown },
            theirs: {
              version: remote.version,
              markdown: storageToMarkdown(
                remote.storage,
                {
                  pageId: page.id,
                  version: remote.version,
                  space: spaceKey,
                  title: remote.title,
                  parentPageId: remote.parentId,
                },
                `attachments/${page.id}`,
              ),
            },
            base: { version: known.version, markdown: known.lastSyncedMarkdown },
          });
          continue;
        }

        const markdown = storageToMarkdown(
          remote.storage,
          {
            pageId: page.id,
            version: remote.version,
            space: spaceKey,
            title: remote.title,
            parentPageId: remote.parentId,
          },
          `attachments/${page.id}`,
        );
        writeFileSync(localFile, markdown);
        state.pages[page.id] = {
          file: known.file,
          version: remote.version,
          markdownHash: hash(bodyOf(markdown)),
          lastSyncedMarkdown: bodyOf(markdown),
        };
        this.writeState(spaceKey, state);
        skipped.push(...(await this.downloadAttachments(client, spaceKey, page.id, state)));
        this.writeState(spaceKey, state);
        updated += 1;
      }

      state.pulledAt = Date.now();
      this.writeState(spaceKey, state);
      const detail =
        `페이지 ${pages.length}개 확인 · ${updated}개 갱신` +
        (conflicts.length > 0 ? ` · 충돌 ${conflicts.length}개` : "") +
        (skipped.length > 0 ? ` · 첨부 ${skipped.length}개 건너뜀 (${skipped[0]}${skipped.length > 1 ? " 외" : ""})` : "");
      return this.emit(spaceKey, {
        phase: conflicts.length > 0 ? "error" : "idle",
        detail,
        conflicts,
      });
    });
  }

  /** Upload edited markdown (and moved attachments) with optimistic locking. */
  push(key: string): Promise<ConfluenceStatus> {
    const spaceKey = spaceKeyForDir(key);
    return this.runExclusive(spaceKey, async () => {
      const client = this.requireClient();
      const state = this.requireState(spaceKey);
      this.emit(spaceKey, { phase: "pushing", detail: null });

      const conflicts: ConfluenceConflict[] = [];
      let pushed = 0;

      for (const file of this.markdownFiles(spaceKey)) {
        const path = join(this.mirror(spaceKey), file);
        const markdown = readFileSync(path, "utf8");
        const { meta } = markdownToStorage(markdown, "");
        if (meta.pageId === undefined || meta.title === undefined || meta.version === undefined) {
          throw new Error(`${file} 에 frontmatter(pageId, version, title)가 없습니다`);
        }
        const localVersion = meta.version;
        const pageId = String(meta.pageId);
        const known = state.pages[pageId];
        const body = bodyOf(markdown);

        if (!known) {
          const created = await client.createPage({
            spaceId: state.spaceId,
            title: meta.title,
            parentId: meta.parentPageId ?? null,
            storage: markdownToStorage(markdown, `attachments/${pageId}`).storage,
          });
          // The body still references attachments/<placeholder>/…; the file
          // and the folder both move onto the real id so a later push finds
          // them (uploadAttachments only walks folders it knows a page for).
          const placeholderDir = join(this.mirror(spaceKey), "attachments", pageId);
          if (existsSync(placeholderDir)) {
            renameSync(placeholderDir, join(this.mirror(spaceKey), "attachments", created.id));
          }
          const updated = withVersion(markdown, created.version, created.id)
            .split(`attachments/${pageId}/`)
            .join(`attachments/${created.id}/`);
          writeFileSync(path, updated);
          state.pages[created.id] = {
            file,
            version: created.version,
            markdownHash: hash(bodyOf(updated)),
            lastSyncedMarkdown: bodyOf(updated),
          };
          // After the file and the state agree on the real id, never before:
          // a listener that re-points on a push that then failed would leave
          // its own records ahead of the mirror.
          this.options.onPageIdentified?.(pageId, created.id);
          pushed += 1;
          continue;
        }

        if (hash(body) === known.markdownHash) continue;

        const remote = await client.getPage(pageId);
        // The optimistic lock is judged against what THIS engine recorded,
        // never against the frontmatter a hand edit can tamper with: claiming
        // the remote's version number must not turn an overwrite into a
        // legitimate push.
        if (remote.version !== known.version) {
          conflicts.push({
            pageId,
            title: meta.title,
            mine: { file, version: localVersion, markdown },
            theirs: {
              version: remote.version,
              markdown: storageToMarkdown(
                remote.storage,
                {
                  pageId,
                  version: remote.version,
                  space: spaceKey,
                  title: remote.title,
                  parentPageId: remote.parentId,
                },
                `attachments/${pageId}`,
              ),
            },
            base: { version: known.version, markdown: known.lastSyncedMarkdown },
          });
          continue;
        }

        const updatedPage = await client.updatePage({
          pageId,
          title: meta.title,
          baseVersion: known.version,
          storage: markdownToStorage(markdown, `attachments/${pageId}`).storage,
        });
        const updated = withVersion(markdown, updatedPage.version, pageId);
        writeFileSync(path, updated);
        state.pages[pageId] = {
          file: known.file,
          version: updatedPage.version,
          markdownHash: hash(body),
          lastSyncedMarkdown: body,
        };
        pushed += 1;
      }

      const uploads = await this.uploadAttachments(client, spaceKey, state);
      this.writeState(spaceKey, state);

      const detail =
        `페이지 ${pushed}개 반영 · 첨부 ${uploads}개 업로드` +
        (conflicts.length > 0 ? ` · 충돌 ${conflicts.length}개 (반영 중단)` : "");
      return this.emit(spaceKey, {
        phase: conflicts.length > 0 ? "error" : "idle",
        detail,
        conflicts,
      });
    });
  }

  /**
   * What 게시 would send, computed without touching anything: every pending
   * page with the line diff between its last synced body and the file now.
   * The confirm dialog shows this before the planner consents — a push writes
   * to Confluence, and "무엇이 올라가는지" is what makes consent informed.
   */
  review(key: string): ConfluenceReview {
    const spaceKey = spaceKeyForDir(key);
    const state = this.readState(spaceKey);
    const dir = mirrorDirName(spaceKey);
    const conflicted = new Set(this.status(spaceKey).conflicts.map((entry) => entry.pageId));
    const pending = this.pageList(spaceKey).filter((page) => page.modified || page.isNew);
    return {
      space: spaceKey,
      pages: pending.map((page) => {
        let body = "";
        try {
          body = bodyOf(readFileSync(join(this.mirror(spaceKey), page.path.slice(dir.length + 1)), "utf8"));
        } catch {
          // A vanished file still shows in the tree; the diff reads as a wipe,
          // which is what a push of it would produce.
        }
        const base = state?.pages[page.pageId]?.lastSyncedMarkdown ?? "";
        const { added, removed, diff } = lineDiff(base, body);
        return {
          path: page.path,
          title: page.title,
          pageId: page.pageId,
          version: page.version,
          nextVersion: page.isNew ? 1 : page.version + 1,
          isNew: page.isNew,
          conflict: conflicted.has(page.pageId),
          added,
          removed,
          diff,
        };
      }),
    };
  }

  // -- attachments --------------------------------------------------------------

  /**
   * Attachments the clone could not fetch are skipped, not fatal. A real space
   * accumulates attachments whose blob is gone or restricted, and one 404 must
   * not cost the planner every page after it: the markdown is the work, the
   * image is decoration, and a clone that stops at page 6 of 36 looks like the
   * tool is broken.
   */
  private async downloadAttachments(
    client: ConfluenceClient,
    spaceKey: string,
    pageId: string,
    state: MirrorState,
  ): Promise<string[]> {
    const skipped: string[] = [];
    for (const attachment of await client.listAttachments(pageId)) {
      const key = `${pageId}/${attachment.title}`;
      let content: ArrayBuffer | Uint8Array;
      try {
        content = await client.downloadAttachment(attachment);
      } catch {
        skipped.push(attachment.title);
        continue;
      }
      const dir = join(this.mirror(spaceKey), "attachments", pageId);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, attachment.title), Buffer.from(content));
      state.attachments[key] = { hash: hash(Buffer.from(content)) };
    }
    return skipped;
  }

  /** Uploads new or content-changed attachment files; same name replaces. */
  private async uploadAttachments(
    client: ConfluenceClient,
    spaceKey: string,
    state: MirrorState,
  ): Promise<number> {
    const root = join(this.mirror(spaceKey), "attachments");
    if (!existsSync(root)) return 0;
    let uploaded = 0;

    for (const pageId of readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)) {
      if (!state.pages[pageId]) continue; // page not created yet: nothing to attach to
      for (const file of readdirSync(join(root, pageId))) {
        const key = `${pageId}/${file}`;
        const content = readFileSync(join(root, pageId, file));
        const digest = hash(content);
        if (state.attachments[key]?.hash === digest) continue;
        await client.uploadAttachment({
          pageId,
          filename: file,
          mediaType: mediaTypeFor(file),
          content: new Uint8Array(content),
        });
        state.attachments[key] = { hash: digest };
        uploaded += 1;
      }
    }
    return uploaded;
  }

  // -- deferral (turn-based exclusion, DESIGN §4.4) ------------------------------

  acquireDeferral(reason: string): Deferral {
    const deferral: Deferral = {
      reason,
      release: () => {
        this.deferrals.delete(deferral);
      },
    };
    this.deferrals.add(deferral);
    return deferral;
  }

  get deferralReasons(): string[] {
    return [...this.deferrals].map((deferral) => deferral.reason);
  }

  /**
   * Periodic pull that skips every tick while a deferral is held — the
   * unsaved-editor/running-turn exclusion. Errors land in the space status.
   * One timer per space, so several mirrors run side by side and stopping one
   * leaves the others alone.
   */
  startBackgroundPull(key: string, intervalMs: number): void {
    const spaceKey = spaceKeyForDir(key);
    this.stopBackgroundPull(spaceKey);
    const timer = setInterval(() => {
      if (this.deferrals.size > 0) return;
      if (!existsSync(join(this.mirror(spaceKey), STATE_FILE))) return;
      void this.pull(spaceKey).catch((error) => {
        this.emit(spaceKey, {
          phase: "error",
          detail: error instanceof Error ? error.message : String(error),
        });
      });
    }, intervalMs);
    timer.unref();
    this.backgroundTimers.set(spaceKey, timer);
  }

  /** Stops one space's timer, or every timer when no space is given. */
  stopBackgroundPull(key?: string): void {
    const spaceKey = key === undefined ? undefined : spaceKeyForDir(key);
    if (spaceKey === undefined) {
      for (const timer of this.backgroundTimers.values()) clearInterval(timer);
      this.backgroundTimers.clear();
      return;
    }
    const timer = this.backgroundTimers.get(spaceKey);
    if (timer) {
      clearInterval(timer);
      this.backgroundTimers.delete(spaceKey);
    }
  }

  /** Spaces with a running background pull (the daemon reconciles these). */
  backgroundPullSpaces(): string[] {
    return [...this.backgroundTimers.keys()];
  }

  // -- plumbing --------------------------------------------------------------

  private requireClient(): ConfluenceClient {
    const client = this.options.clientFactory();
    if (!client) {
      throw new Error("Confluence 연결 정보가 설정되지 않았습니다 — 설정에서 사이트 주소·이메일·API 토큰을 넣어 주세요.");
    }
    return client;
  }

  /** Accepts either spelling: a caller may hand back a path's folder name. */
  private mirror(spaceKey: string): string {
    return join(this.options.root, mirrorDirName(spaceKeyForDir(spaceKey)));
  }

  private requireState(spaceKey: string): MirrorState {
    const state = this.readState(spaceKey);
    if (!state) {
      throw new Error(`스페이스 ${spaceKey} 미러가 없습니다 — 먼저 confluence.sync으로 복제해 주세요.`);
    }
    return state;
  }

  private readState(spaceKey: string): MirrorState | null {
    try {
      return JSON.parse(readFileSync(join(this.mirror(spaceKey), STATE_FILE), "utf8")) as MirrorState;
    } catch {
      return null;
    }
  }

  private writeState(spaceKey: string, state: MirrorState): void {
    mkdirSync(this.mirror(spaceKey), { recursive: true });
    const file = join(this.mirror(spaceKey), STATE_FILE);
    const temporary = `${file}.drafthouse-${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(temporary, file);
  }

  private markdownFiles(spaceKey: string): string[] {
    const dir = this.mirror(spaceKey);
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name)
      .sort();
  }

  /** One operation per space at a time; callers race-safe. */
  private runExclusive(
    spaceKey: string,
    operation: () => Promise<ConfluenceStatus>,
  ): Promise<ConfluenceStatus> {
    const existing = this.inFlight.get(spaceKey);
    if (existing) return existing;
    const promise = operation()
      .catch((error) =>
        this.emit(spaceKey, {
          phase: "error",
          detail: error instanceof Error ? error.message : String(error),
        }),
      )
      .finally(() => this.inFlight.delete(spaceKey));
    this.inFlight.set(spaceKey, promise);
    return promise;
  }

  private emit(
    spaceKey: string,
    patch: { phase: ConfluencePhase; detail: string | null; conflicts?: ConfluenceConflict[] },
  ): ConfluenceStatus {
    const state = this.readState(spaceKey);
    const status: ConfluenceStatus = {
      space: spaceKey,
      phase: patch.phase,
      pages: Object.keys(state?.pages ?? {}).length,
      detail: patch.detail,
      pulledAt: state?.pulledAt ?? null,
      conflicts: patch.conflicts ?? this.statuses.get(spaceKey)?.conflicts ?? [],
    };
    this.statuses.set(spaceKey, status);
    this.options.onStatus(status);
    return status;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hash(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 32);
}

/** The markdown body: everything after the closing frontmatter delimiter. */
export function bodyOf(markdown: string): string {
  const lines = markdown.split("\n");
  if (lines[0] !== "---") return markdown;
  const end = lines.indexOf("---", 1);
  return end < 0 ? markdown : lines.slice(end + 1).join("\n").replace(/^\n+/, "");
}

/** Rewrites version and pageId in a file's frontmatter, body untouched. */
function withVersion(markdown: string, version: number, pageId: string): string {
  const lines = markdown.split("\n");
  if (lines[0] !== "---") return markdown;
  const end = lines.indexOf("---", 1);
  if (end < 0) return markdown;
  const frontmatter = lines.slice(1, end).map((line) =>
    /^version: /.test(line)
      ? `version: ${version}`
      : /^pageId: /.test(line)
        ? `pageId: "${pageId.replace(/"/g, '\\"')}"`
        : line,
  );
  return [lines[0]!, ...frontmatter, ...lines.slice(end)].join("\n");
}

/**
 * Attachment file name as stored under attachments/<pageId>/: the basename
 * only. Traversal segments, separators, the dot names, drive letters, and
 * control characters are refused in Korean — the name crosses the wire from
 * a client, so nothing here is trusted.
 */
export function sanitizeAttachmentFilename(filename: string): string {
  // A separator anywhere means the client sent a path, not a name: refuse it
  // loudly instead of silently flattening — the write destination is only
  // provably confined when the name cannot carry structure at all.
  if (filename === "" || filename === "." || filename === ".." || /[\\/]/.test(filename)) {
    throw new Error("첨부 파일 이름이 올바르지 않습니다 — 경로 없이 파일명만 보내 주세요.");
  }
  if (/[<>:"|?*\u0000-\u001f]/.test(filename)) {
    throw new Error(`첨부 파일 이름에 쓸 수 없는 문자가 있습니다: ${filename}`);
  }
  return filename;
}

/** Filesystem-safe page file name, unique within the mirror. */
export function pageFileName(title: string, taken: Set<string>): string {
  const cleaned = title.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, "").replace(/^\.+/, "").trim() || "제목 없음";
  let candidate = `${cleaned}.md`;
  for (let n = 2; taken.has(candidate); n += 1) candidate = `${cleaned}-${n}.md`;
  taken.add(candidate);
  return candidate;
}

function mediaTypeFor(filename: string): string {
  const extension = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  const types: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
    ".txt": "text/plain",
    ".csv": "text/csv",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  };
  return types[extension] ?? "application/octet-stream";
}


export type { PageMeta };

const DIFF_CAP = 400;

/**
 * Line diff with `+`/`-` prefixes only — review dialogs want what changed,
 * not a reading copy. 기획서 bodies are small, so the O(size²) LCS table is
 * fine; the output is capped so a pathological page cannot flood the UI.
 */
function lineDiff(before: string, after: string): { added: number; removed: number; diff: string } {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const lines: string[] = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      lines.push(`-${a[i]}`);
      removed += 1;
      i += 1;
    } else {
      lines.push(`+${b[j]}`);
      added += 1;
      j += 1;
    }
  }
  while (i < a.length) {
    lines.push(`-${a[i]}`);
    removed += 1;
    i += 1;
  }
  while (j < b.length) {
    lines.push(`+${b[j]}`);
    added += 1;
    j += 1;
  }
  const capped =
    lines.length > DIFF_CAP ? [...lines.slice(0, DIFF_CAP), `… (${lines.length - DIFF_CAP}줄 더)`] : lines;
  return { added, removed, diff: capped.join("\n") };
}
