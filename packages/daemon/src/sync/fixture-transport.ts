/**
 * Confluence's side of the REST transport: the real network transport and the
 * env switch that picks recorded fixtures instead. The interface itself, and
 * the fixture replay both clients share, live in ../rest-transport.js.
 */
import { FixtureTransport, loadFixturePairs, type RestTransport } from "../rest-transport.js";

/**
 * The transport the daemon uses outside tests. The site url is normalized
 * once (scheme added, trailing slash dropped) so "colosseum.atlassian.net/"
 * and "https://colosseum.atlassian.net" build the same absolute request url.
 */
export class FetchTransport implements RestTransport {
  private readonly siteUrl: string;

  constructor(siteUrl: string) {
    this.siteUrl = normalizeSiteUrl(siteUrl);
  }

  async request(input: {
    method: "GET" | "POST" | "PUT" | "PATCH";
    url: string;
    headers: Record<string, string>;
    body?: Uint8Array;
  }): Promise<{ status: number; body: Uint8Array; headers: Record<string, string> }> {
    if (!this.siteUrl) {
      throw new Error("Confluence 사이트 주소가 비어 있습니다 — 설정에서 사이트 주소를 입력해 주세요.");
    }
    const response = await fetch(`${this.siteUrl}${input.url}`, {
      method: input.method,
      headers: input.headers,
      body: input.body ? Buffer.from(input.body) : undefined,
    });
    // Headers is only iterable with lib.dom.iterable; forEach is what every
    // runtime and this tsconfig agree on.
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    return {
      status: response.status,
      body: new Uint8Array(await response.arrayBuffer()),
      headers,
    };
  }
}

/**
 * Trims, adds https:// when no scheme was typed, and drops trailing slashes.
 * An empty or whitespace-only value stays empty so the transport can name
 * the problem instead of fetching a relative url.
 */
export function normalizeSiteUrl(siteUrl: string): string {
  const trimmed = siteUrl.trim();
  if (trimmed === "") return "";
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return withScheme.replace(/\/+$/, "");
}

/**
 * Fixture transport when CDS_DESIGN_CONFLUENCE_FIXTURE points at a loadable
 * fixture directory; otherwise `transport` is null and the caller builds a
 * FetchTransport for the configured site. (A non-null placeholder here used
 * to shadow the caller's per-site fallback and send every request to a
 * relative url — "Failed to parse URL from /wiki/api/v2/spaces".)
 */
export function createConfluenceTransport(env: NodeJS.ProcessEnv = process.env): {
  transport: RestTransport | null;
  fixtureDir: string | null;
} {
  const fixtureDir = env.CDS_DESIGN_CONFLUENCE_FIXTURE ?? null;
  if (fixtureDir) {
    try {
      return { transport: new FixtureTransport(loadFixturePairs(fixtureDir)), fixtureDir };
    } catch {
      return { transport: null, fixtureDir };
    }
  }
  return { transport: null, fixtureDir: null };
}

