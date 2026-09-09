/**
 * Confluence Cloud REST client (v2 pages/spaces, v1 attachments) over an
 * injectable fetch-shaped transport.
 *
 * The transport interface exists so tests can serve recorded golden fixtures
 * (packages/daemon/test/fixtures/confluence/) instead of the network; the
 * daemon also selects that transport when DRAFTHOUSE_CONFLUENCE_FIXTURE points
 * at a fixture directory. No code path here talks to anything but the
 * transport it was given.
 *
 * Endpoints used (cite in every fixture):
 *   GET  /wiki/api/v2/spaces                                    — spaces list
 *   GET  /wiki/api/v2/spaces/{spaceId}/pages                    — pages (cursor-paginated)
 *   GET  /wiki/api/v2/pages/{pageId}/children                   — child pages (cursor-paginated)
 *   GET  /wiki/api/v2/pages/{pageId}/ancestors                  — ancestor ids, outermost first
 *   GET  /wiki/api/v2/pages/{pageId}?body-format=storage        — page with storage body
 *   POST /wiki/api/v2/pages                                     — create page
 *   PUT  /wiki/api/v2/pages/{pageId}                            — update (version.number+1 optimistic lock)
 *   GET  /wiki/rest/api/content/{pageId}/child/attachment       — attachments (v1)
 *   GET  {attachment._links.download}                           — attachment bytes
 *   POST /wiki/rest/api/content/{pageId}/child/attachment       — multipart upload (v1; same
 *                                                                  filename → new version)
 */

import type { RestTransport } from "../rest-transport.js";

export interface ConfluenceCredentials {
  siteUrl: string;
  email: string;
  apiToken: string;
}

export interface SpaceRef {
  id: string;
  key: string;
  name: string;
}

export interface PageRef {
  id: string;
  title: string;
  parentId: string | null;
  version: number;
}

export interface PageBody {
  id: string;
  title: string;
  parentId: string | null;
  version: number;
  storage: string;
}

export interface AttachmentRef {
  id: string;
  title: string;
  mediaType: string;
  version: number;
  /** Path+query to fetch the bytes, relative to the site. */
  download: string;
}

const JSON_HEADERS = { accept: "application/json" };

/**
 * Cursor pages a single listing follows before giving up. Far beyond any real
 * space or site; it exists so a cursor that repeats or never advances ends the
 * loop instead of the process.
 */
const MAX_PAGES = 500;

export class ConfluenceClient {
  constructor(
    private readonly credentials: ConfluenceCredentials,
    private readonly transport: RestTransport,
  ) {}

  /** `undefined` until asked, then the id or `null` when the site would not say. */
  private accountId: string | null | undefined;

  // -- spaces ---------------------------------------------------------------

  /**
   * Every space the credentials can see. `limit` sizes the first page only:
   * the cursor in `_links.next` is followed to the end, because a site with
   * more spaces than one page used to hide the planner's space from both the
   * picker and `findSpace` (which then failed with 찾을 수 없습니다).
   */
  async listSpaces(limit = 100): Promise<SpaceRef[]> {
    const spaces = await this.fetchSpaces(limit);
    const mine = await this.currentAccountId();
    // Without an account id we cannot tell whose personal space is whose, and
    // hiding the planner's own would be worse than showing a few extras.
    if (!mine) return spaces.map(({ id, key, name }) => ({ id, key, name }));
    return spaces
      .filter(
        (space) =>
          space.type !== "personal" || space.authorId === mine || space.key === `~${mine}`,
      )
      .map(({ id, key, name }) => ({ id, key, name }));
  }

  /**
   * Lookups see every space, picker or not: a mirror cloned before this filter
   * existed must keep pulling, even if the space belongs to someone else.
   */
  async findSpace(keyOrId: string): Promise<SpaceRef> {
    const spaces = await this.fetchSpaces(100);
    const found = spaces.find((space) => space.key === keyOrId || space.id === keyOrId);
    if (!found) throw new Error(`스페이스를 찾을 수 없습니다: ${keyOrId}`);
    return { id: found.id, key: found.key, name: found.name };
  }

  /** Every space the credentials can see, with what tells personal ones apart. */
  private async fetchSpaces(
    limit: number,
  ): Promise<Array<SpaceRef & { type: string; authorId: string | null }>> {
    const spaces: Array<SpaceRef & { type: string; authorId: string | null }> = [];
    const seen = new Set<string>();
    let url: string | null = withQuery("/wiki/api/v2/spaces", { limit });
    // A cursor that never advances (or repeats itself) must not spin forever.
    for (let page = 0; url !== null && page < MAX_PAGES; page += 1) {
      const data = await this.getJson(url);
      for (const raw of data.results as Array<Record<string, unknown>>) {
        const id = String(raw.id);
        if (seen.has(id)) continue;
        seen.add(id);
        spaces.push({
          id,
          key: String(raw.key),
          name: String(raw.name),
          type: typeof raw.type === "string" ? raw.type : "global",
          authorId: typeof raw.authorId === "string" ? raw.authorId : null,
        });
      }
      const next = (data._links as Record<string, string> | undefined)?.next;
      url = next && next !== url ? next : null;
    }
    return spaces;
  }

  /**
   * The signed-in account, asked once per client. Personal spaces are keyed
   * `~accountId`, so this is what tells "내 개인 스페이스" from everyone else's.
   * A site that refuses the call (or a fixture that has no such pair) simply
   * leaves the picker unfiltered.
   */
  private async currentAccountId(): Promise<string | null> {
    if (this.accountId !== undefined) return this.accountId;
    try {
      const me = await this.getJson("/wiki/rest/api/user/current");
      this.accountId = typeof me.accountId === "string" ? me.accountId : null;
    } catch {
      this.accountId = null;
    }
    return this.accountId ?? null;
  }

  // -- pages ----------------------------------------------------------------

  async listSpacePages(spaceId: string): Promise<PageRef[]> {
    const pages: PageRef[] = [];
    const seen = new Set<string>();
    let url: string | null = `/wiki/api/v2/spaces/${spaceId}/pages?limit=50`;
    for (let page = 0; url !== null && page < MAX_PAGES; page += 1) {
      const data = await this.getJson(url);
      for (const raw of data.results as Array<Record<string, unknown>>) {
        const id = String(raw.id);
        if (seen.has(id)) continue;
        seen.add(id);
        pages.push({
          id,
          title: String(raw.title),
          parentId: raw.parentId === undefined || raw.parentId === null ? null : String(raw.parentId),
          version: Number((raw.version as Record<string, unknown> | undefined)?.number ?? 0),
        });
      }
      // v2 pagination: `results`, `_links.next` carries the cursor.
      const next = (data._links as Record<string, string> | undefined)?.next;
      url = next && next !== url ? next : null;
    }
    return pages;
  }

  /**
   * A page and everything under it, breadth-first with the root first — what
   * a project scoped to a subtree clones and pulls instead of a whole space.
   *
   * The children endpoint carries neither a version nor a parentId: the
   * parent is the page we asked about, and a missing version stays 0.
   * That 0 is safe because it is never trusted as "already up to date" —
   * clone re-fetches every body regardless, and pull compares against the
   * state file, where 0 can only mean "fetch it".
   */
  async listSubtreePages(rootPageId: string): Promise<PageRef[]> {
    const root = await this.getPage(rootPageId);
    const pages: PageRef[] = [
      { id: root.id, title: root.title, parentId: root.parentId, version: root.version },
    ];
    const seen = new Set([root.id]);

    // The queue is `pages` itself: every entry appended is a parent still to
    // walk, so the array ends up in the breadth-first order it is read in.
    for (let at = 0; at < pages.length; at += 1) {
      const parentId = pages[at]!.id;
      let url: string | null = `/wiki/api/v2/pages/${parentId}/children?limit=50`;
      for (let page = 0; url !== null && page < MAX_PAGES; page += 1) {
        const data = await this.getJson(url);
        for (const raw of (data.results as Array<Record<string, unknown>> | undefined) ?? []) {
          const id = String(raw.id);
          // A page reached twice (a cycle, or a cursor that repeats a result)
          // would otherwise be walked forever.
          if (seen.has(id)) continue;
          seen.add(id);
          pages.push({
            id,
            title: String(raw.title),
            parentId,
            version: Number((raw.version as Record<string, unknown> | undefined)?.number ?? 0),
          });
        }
        const next = (data._links as Record<string, string> | undefined)?.next;
        url = next && next !== url ? next : null;
      }
    }
    return pages;
  }

  /**
   * Ancestor ids, outermost first — what tells whether a candidate project
   * root already sits inside another project's subtree. A site that refuses
   * the call must not block 프로젝트 만들기, so the overlap check is left to
   * judge on the roots it could resolve.
   */
  async pageAncestors(pageId: string): Promise<string[]> {
    try {
      const data = await this.getJson(`/wiki/api/v2/pages/${pageId}/ancestors`);
      return ((data.results as Array<Record<string, unknown>> | undefined) ?? []).map((raw) =>
        String(raw.id),
      );
    } catch {
      return [];
    }
  }

  async getPage(pageId: string): Promise<PageBody> {
    const data = await this.getJson(`/wiki/api/v2/pages/${pageId}`, { "body-format": "storage" });
    const body = (data.body as Record<string, Record<string, unknown>> | undefined)?.storage;
    return {
      id: String(data.id),
      title: String(data.title),
      parentId: data.parentId === undefined || data.parentId === null ? null : String(data.parentId),
      version: Number((data.version as Record<string, unknown>)?.number ?? 0),
      storage: String(body?.value ?? ""),
    };
  }

  async createPage(input: {
    spaceId: string;
    title: string;
    parentId?: string | null;
    storage: string;
  }): Promise<PageBody> {
    const data = await this.sendJson("POST", "/wiki/api/v2/pages", {
      spaceId: input.spaceId,
      status: "current",
      title: input.title,
      ...(input.parentId ? { parentId: input.parentId } : {}),
      body: { representation: "storage", value: input.storage },
    });
    return {
      id: String(data.id),
      title: String(data.title),
      parentId: input.parentId ?? null,
      version: Number((data.version as Record<string, unknown>)?.number ?? 1),
      storage: input.storage,
    };
  }

  /**
   * Optimistic-lock update: sends `version.number = base + 1`. Confluence
   * rejects a stale base with 409, which the engine also pre-checks by
   * comparing the recorded version first.
   */
  async updatePage(input: {
    pageId: string;
    title: string;
    baseVersion: number;
    storage: string;
  }): Promise<PageBody> {
    const data = await this.sendJson("PUT", `/wiki/api/v2/pages/${input.pageId}`, {
      id: Number(input.pageId),
      status: "current",
      title: input.title,
      body: { representation: "storage", value: input.storage },
      version: { number: input.baseVersion + 1 },
    });
    return {
      id: String(data.id),
      title: String(data.title),
      parentId: null,
      version: Number((data.version as Record<string, unknown>)?.number ?? input.baseVersion + 1),
      storage: input.storage,
    };
  }

  // -- attachments (v1) -----------------------------------------------------

  async listAttachments(pageId: string): Promise<AttachmentRef[]> {
    const data = await this.getJson(`/wiki/rest/api/content/${pageId}/child/attachment`, {
      limit: 200,
      expand: "version",
    });
    return (data.results as Array<Record<string, any>>).map((raw) => ({
      id: String(raw.id),
      title: String(raw.title),
      mediaType: String(raw.metadata?.mediaType ?? "application/octet-stream"),
      version: Number(raw.version?.number ?? 1),
      download: String(raw._links?.download ?? ""),
    }));
  }

  async downloadAttachment(attachment: AttachmentRef): Promise<Uint8Array> {
    const { status, body } = await this.transport.request({
      method: "GET",
      url: attachment.download,
      headers: { ...this.authHeader(), accept: attachment.mediaType },
    });
    if (status !== 200) throw new Error(`첨부 파일을 내려받지 못했습니다 (exit ${status}): ${attachment.title}`);
    return body;
  }

  /** Uploads bytes; posting the same filename again creates a new version. */
  async uploadAttachment(input: {
    pageId: string;
    filename: string;
    mediaType: string;
    content: Uint8Array;
    comment?: string;
  }): Promise<AttachmentRef> {
    const boundary = `drafthouse-${Date.now().toString(16)}`;
    const parts: Uint8Array[] = [];
    const push = (text: string) => parts.push(new TextEncoder().encode(text));

    push(`--${boundary}\r\n`);
    push(`Content-Disposition: form-data; name="file"; filename="${input.filename}"\r\n`);
    push(`Content-Type: ${input.mediaType}\r\n\r\n`);
    parts.push(input.content);
    push(`\r\n--${boundary}\r\n`);
    push(`Content-Disposition: form-data; name="comment"\r\n\r\n`);
    push(input.comment ?? "Drafthouse");
    push(`\r\n--${boundary}--\r\n`);

    const length = parts.reduce((total, part) => total + part.byteLength, 0);
    const body = new Uint8Array(length);
    let at = 0;
    for (const part of parts) {
      body.set(part, at);
      at += part.byteLength;
    }

    const data = await this.sendJson(
      "POST",
      `/wiki/rest/api/content/${input.pageId}/child/attachment`,
      body,
      {
        "content-type": `multipart/form-data; boundary=${boundary}`,
        // Confluence requires this header instead of an XSRF token.
        "X-Atlassian-Token": "no-check",
      },
    );
    return {
      id: String(data.id),
      title: String(data.title),
      mediaType: String(data.metadata?.mediaType ?? input.mediaType),
      version: Number(data.version?.number ?? 1),
      download: String(data._links?.download ?? ""),
    };
  }

  // -- plumbing --------------------------------------------------------------

  private authHeader(): Record<string, string> {
    return { authorization: `Basic ${basicAuth(this.credentials)}` };
  }

  private async getJson(url: string, query: Record<string, string | number> = {}): Promise<any> {
    const full = withQuery(url, query);
    const { status, body } = await this.transport.request({
      method: "GET",
      url: full,
      headers: { ...this.authHeader(), ...JSON_HEADERS },
    });
    if (status !== 200) throw new Error(httpError("Confluence 요청", status, body));
    return JSON.parse(new TextDecoder().decode(body));
  }

  private async sendJson(
    method: "POST" | "PUT",
    url: string,
    payload: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<any> {
    const bytes =
      payload instanceof Uint8Array ? payload : new TextEncoder().encode(JSON.stringify(payload));
    const { status, body } = await this.transport.request({
      method,
      url,
      headers: {
        ...this.authHeader(),
        ...JSON_HEADERS,
        ...(payload instanceof Uint8Array ? {} : { "content-type": "application/json" }),
        ...extraHeaders,
      },
      body: bytes,
    });
    if (status !== 200) throw new Error(httpError("Confluence 요청", status, body));
    return JSON.parse(new TextDecoder().decode(body));
  }
}

export function basicAuth(credentials: ConfluenceCredentials): string {
  return Buffer.from(`${credentials.email}:${credentials.apiToken}`).toString("base64");
}

function withQuery(url: string, query: Record<string, string | number>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) params.set(key, String(value));
  const text = params.toString();
  const [path, existing] = url.split("?");
  const merged = [existing, text].filter(Boolean).join("&");
  return merged ? `${path}?${merged}` : (path ?? url);
}

function httpError(label: string, status: number, body: Uint8Array): string {
  const text = new TextDecoder().decode(body.subarray(0, 500));
  return `${label} 실패 (exit ${status}): ${text.split("\n")[0] ?? ""}`;
}
