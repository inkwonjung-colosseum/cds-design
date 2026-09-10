/**
 * Which 기획서 each thread is about (PLAN D2).
 *
 * The Agent SDK stores transcripts per directory and knows nothing else about
 * them, so the page a thread belongs to has to live beside them. One file per
 * project, `projects/<slug>/sessions.json`, holding nothing but
 * `sessionId → pageId`: the workspace is already implied by which transcript
 * store the session came from, and the title is the transcript's own.
 *
 * The awkward part this exists to absorb: a 기획서 a planning session just
 * wrote carries a LOCAL `new-…` pageId until 게시 creates it in Confluence,
 * and then its id changes. Losing the attachment at that exact moment would
 * scatter a page's threads on its first publish — the one moment the planner
 * is most likely to be looking. `repoint` is called from the push path with
 * the placeholder and the real id, so the move is atomic with the rewrite of
 * the page file itself.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class SessionPages {
  private constructor(
    private readonly file: string,
    private readonly pages: Record<string, string>,
  ) {}

  /** Reads the sidecar, tolerating anything a hand edit or a crash could leave. */
  static load(file: string): SessionPages {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      const pages: Record<string, string> = {};
      for (const [sessionId, pageId] of Object.entries(parsed)) {
        if (typeof pageId === "string" && pageId !== "") pages[sessionId] = pageId;
      }
      return new SessionPages(file, pages);
    } catch {
      return new SessionPages(file, {});
    }
  }

  pageOf(sessionId: string): string | null {
    return this.pages[sessionId] ?? null;
  }

  attach(sessionId: string, pageId: string): void {
    if (this.pages[sessionId] === pageId) return;
    this.pages[sessionId] = pageId;
    this.save();
  }

  detach(sessionId: string): void {
    if (!(sessionId in this.pages)) return;
    delete this.pages[sessionId];
    this.save();
  }

  /**
   * A page's local `new-…` placeholder became its real Confluence id. Every
   * thread attached to the placeholder follows it.
   */
  repoint(previousPageId: string, pageId: string): void {
    let moved = false;
    for (const [sessionId, current] of Object.entries(this.pages)) {
      if (current !== previousPageId) continue;
      this.pages[sessionId] = pageId;
      moved = true;
    }
    if (moved) this.save();
  }

  /**
   * Drops attachments for threads that no longer exist. Transcripts can be
   * deleted from a terminal, and an entry nobody can reach would otherwise
   * keep a page's tab count wrong forever.
   */
  prune(knownSessionIds: ReadonlySet<string>): void {
    let dropped = false;
    for (const sessionId of Object.keys(this.pages)) {
      if (knownSessionIds.has(sessionId)) continue;
      delete this.pages[sessionId];
      dropped = true;
    }
    if (dropped) this.save();
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    // Atomic replace: a half-written sidecar reads as no attachments at all,
    // which silently scatters every thread in the project.
    const temporary = `${this.file}.cds-design-${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify(this.pages, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.file);
  }
}
