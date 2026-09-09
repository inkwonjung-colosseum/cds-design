/**
 * GitHub REST client for 개발자에게 넘기기 (PLAN D5): the planner presses one
 * button and a developer gets a pull request. Credentials plus an injected
 * RestTransport, exactly like ConfluenceClient — no code path here talks to
 * anything but the transport it was given, so the offline suites drive the
 * real client against recorded pairs
 * (packages/daemon/test/fixtures/github/) and the daemon selects that same
 * transport when DRAFTHOUSE_GITHUB_FIXTURE points at a fixture directory.
 *
 * Endpoints used (cite in every fixture):
 *   POST  /repos/{owner}/{repo}/pulls                          — open a pull request
 *   PATCH /repos/{owner}/{repo}/pulls/{number}                 — retitle/rewrite a standing one
 *   GET   /repos/{owner}/{repo}/pulls/{number}                 — state + merged flag
 *   GET   /repos/{owner}/{repo}/pulls/{number}/reviews         — latest verdict per reviewer
 *   GET   /repos/{owner}/{repo}                                — permissions.push probe (onboarding gate)
 */
import {
  FixtureTransport,
  loadFixturePairs,
  type RestTransport,
} from "./rest-transport.js";

export interface PullRequestRef {
  number: number;
  url: string;
  title: string;
  /**
   * `changes_requested` is a review verdict rather than a PR state; the tree
   * badge treats it as its own thing, so it is resolved here once instead of
   * at every reader.
   */
  state: "open" | "changes_requested" | "merged" | "closed";
  /** The branch the PR is from — the one 저장 keeps pushing to. */
  branch: string;
}

const JSON_HEADERS = {
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
};

/**
 * Reviews read for the verdict. GitHub pages this endpoint at 100 per page and
 * one planner's work bundle never collects more; asking for a second page
 * would cost a request per status poll to learn nothing.
 */
const REVIEW_PAGE_SIZE = 100;

/** Review states that decide the verdict; COMMENTED and PENDING carry none. */
const VERDICTS = ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"];

export class GitHubClient {
  constructor(
    private readonly token: string,
    private readonly transport: RestTransport,
  ) {}

  /**
   * A brand-new pull request cannot carry a review yet, so its state is read
   * off the create response alone — no reviews call on the button press the
   * planner is waiting on.
   */
  async createPullRequest(input: {
    owner: string;
    repo: string;
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<PullRequestRef> {
    const data = await this.sendJson(
      "POST",
      `/repos/${input.owner}/${input.repo}/pulls`,
      { title: input.title, body: input.body, head: input.head, base: input.base },
      "개발자에게 넘기기",
    );
    return { ...refOf(data), state: stateOf(data) };
  }

  /** Retitles/rewrites a standing pull request as later saves add pages to it. */
  async updatePullRequest(input: {
    owner: string;
    repo: string;
    number: number;
    title?: string;
    body?: string;
  }): Promise<PullRequestRef> {
    const payload: Record<string, string> = {};
    if (input.title !== undefined) payload.title = input.title;
    if (input.body !== undefined) payload.body = input.body;
    const data = await this.sendJson(
      "PATCH",
      `/repos/${input.owner}/${input.repo}/pulls/${input.number}`,
      payload,
      "넘긴 작업 갱신",
    );
    return await this.withVerdict(input.owner, input.repo, data);
  }

  async getPullRequest(input: {
    owner: string;
    repo: string;
    number: number;
  }): Promise<PullRequestRef> {
    const data = await this.getJson(
      `/repos/${input.owner}/${input.repo}/pulls/${input.number}`,
      "넘긴 작업 상태 확인",
    );
    return await this.withVerdict(input.owner, input.repo, data);
  }

  /**
   * Whether this token may open pull requests, and the Korean reason when it
   * may not. Answers, never throws: this runs inside the onboarding gate,
   * where an unreachable GitHub must produce one line in the list instead of
   * breaking the whole list. The token rides in a header and never in a url
   * or a body, so nothing quoted back here can carry it.
   */
  async verifyPullRequestAccess(input: {
    owner: string;
    repo: string;
  }): Promise<{ ok: boolean; detail: string | null }> {
    let status: number;
    let body: Uint8Array;
    let headers: Record<string, string> | undefined;
    try {
      ({ status, body, headers } = await this.transport.request({
        method: "GET",
        url: `/repos/${input.owner}/${input.repo}`,
        headers: this.headers(),
      }));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { ok: false, detail: `GitHub에 연결하지 못해 권한을 확인하지 못했습니다 — ${reason}` };
    }

    if (status === 401) {
      return { ok: false, detail: "토큰이 유효하지 않습니다 — GitHub에서 토큰을 새로 만들어 다시 넣어 주세요." };
    }
    if (status === 403 || status === 404) {
      // 404 is also what GitHub answers for a private repo a token cannot
      // see: "없음"과 "권한 없음"은 여기서 구분되지 않는다.
      return {
        ok: false,
        detail:
          `${input.owner}/${input.repo} 레포에 접근할 수 없습니다 — 레포 주소가 맞는지, ` +
          `토큰이 이 레포를 볼 수 있는지 확인해 주세요.`,
      };
    }
    if (status < 200 || status >= 300) {
      return { ok: false, detail: httpError("레포 권한 확인", status, body) };
    }

    // An unparseable 200 (a proxy's login page) leaves `permissions` absent
    // and falls through to the scopes header, which is answer enough.
    let data: { permissions?: { push?: boolean } } = {};
    try {
      data = JSON.parse(new TextDecoder().decode(body));
    } catch {
      data = {};
    }
    // The authoritative answer when the token's own account is asked about a
    // repo it can see; fine-grained tokens send it too.
    if (typeof data.permissions?.push === "boolean") {
      if (data.permissions.push) return { ok: true, detail: null };
      return {
        ok: false,
        detail:
          `${input.owner}/${input.repo} 레포에 쓸 수 있는 권한이 없어서 개발자에게 넘길 수 없습니다 — ` +
          `이 레포에 쓰기 권한이 있는 계정의 토큰을 넣어 주세요.`,
      };
    }

    // No permissions block: fall back to what the token itself advertises.
    // A classic PAT sends x-oauth-scopes (empty when it was issued without
    // any); a fine-grained token sends the header not at all, so a MISSING
    // header must not be read as a refusal — that would reject exactly the
    // tokens GitHub now recommends.
    const scopes = headers?.["x-oauth-scopes"];
    if (scopes === undefined) return { ok: true, detail: null };
    if (scopes.split(",").some((scope) => scope.trim() === "repo")) {
      return { ok: true, detail: null };
    }
    return {
      ok: false,
      detail: "토큰 권한이 부족합니다 — GitHub에서 토큰을 만들 때 repo 권한을 켜고 다시 넣어 주세요.",
    };
  }

  // -- plumbing --------------------------------------------------------------

  /**
   * An open PR's badge depends on its reviews; a merged or closed one does
   * not, and skipping that request keeps the status poll to one call in the
   * state the planner sits in longest (반영됨).
   */
  private async withVerdict(
    owner: string,
    repo: string,
    data: Record<string, any>,
  ): Promise<PullRequestRef> {
    const state = stateOf(data);
    if (state !== "open") return { ...refOf(data), state };
    const changesRequested = await this.changesRequested(owner, repo, Number(data.number));
    return { ...refOf(data), state: changesRequested ? "changes_requested" : "open" };
  }

  /**
   * Whether the newest verdict of any reviewer still asks for changes.
   * Reviews come back chronologically and one per submission, so a reviewer
   * who requested changes and later approved must be represented by the
   * approval only — keeping the last verdict per login is what makes that
   * true. COMMENTED/PENDING rows are not verdicts and do not displace one.
   *
   * A refused reviews call leaves the PR 열림 rather than failing the whole
   * status read (the precedent is pageAncestors): the link the planner needs
   * is already in hand, and a wrong badge is recoverable at the next poll.
   */
  private async changesRequested(owner: string, repo: string, number: number): Promise<boolean> {
    let reviews: Array<Record<string, any>>;
    try {
      reviews = await this.getJson(
        `/repos/${owner}/${repo}/pulls/${number}/reviews?per_page=${REVIEW_PAGE_SIZE}`,
        "리뷰 확인",
      );
    } catch {
      return false;
    }
    if (!Array.isArray(reviews)) return false;

    const latest: Record<string, string> = {};
    for (const review of reviews) {
      const state = String(review.state ?? "").toUpperCase();
      if (!VERDICTS.includes(state)) continue;
      latest[String(review.user?.login ?? "")] = state;
    }
    return Object.values(latest).includes("CHANGES_REQUESTED");
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.token}`, ...JSON_HEADERS };
  }

  private async getJson(url: string, label: string): Promise<any> {
    const { status, body } = await this.transport.request({
      method: "GET",
      url,
      headers: this.headers(),
    });
    if (status < 200 || status >= 300) throw new Error(httpError(label, status, body));
    return JSON.parse(new TextDecoder().decode(body));
  }

  private async sendJson(
    method: "POST" | "PATCH",
    url: string,
    payload: unknown,
    label: string,
  ): Promise<any> {
    const { status, body } = await this.transport.request({
      method,
      url,
      headers: { ...this.headers(), "content-type": "application/json" },
      body: new TextEncoder().encode(JSON.stringify(payload)),
    });
    if (status < 200 || status >= 300) throw new Error(httpError(label, status, body));
    return JSON.parse(new TextDecoder().decode(body));
  }
}

/** owner/repo from an https or ssh GitHub remote, or null when it is not GitHub. */
export function parseRepoSlug(url: string): { owner: string; repo: string } | null {
  const trimmed = url.trim();
  // scp-style ("git@github.com:org/repo.git") is not a url any parser takes,
  // and https remotes may carry a PAT as userinfo (authenticatedUrl builds
  // exactly that) — both are reduced to host + path here by hand.
  const match =
    /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]*@)?([^/:]+)[/:]+(.+)$/i.exec(trimmed);
  if (!match) return null;
  const host = match[1]!.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") return null;

  const segments = match[2]!.replace(/\.git$/i, "").replace(/\/+$/, "").split("/");
  if (segments.length !== 2) return null;
  const [owner, repo] = segments;
  // GitHub's own name charset; anything else is a path we misread, not a repo.
  if (!owner || !repo || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return null;
  return { owner, repo };
}

/**
 * Fixture transport when DRAFTHOUSE_GITHUB_FIXTURE points at a loadable
 * fixture directory; otherwise a fetch transport against api.github.com
 * (DRAFTHOUSE_GITHUB_API repoints it at a local server).
 *
 * Unlike createConfluenceTransport this returns a usable transport in both
 * cases, because the api base is a constant rather than per-project settings:
 * there is no caller-side fallback for a non-null placeholder to shadow (the
 * Confluence one used to swallow the per-site url and send every request to a
 * relative path — "Failed to parse URL from /wiki/api/v2/spaces"). `fixtureDir`
 * still reports what was ASKED for, so a caller seeing a non-null directory
 * next to a fetch transport knows the fixtures failed to load and must say so
 * instead of quietly reaching the real GitHub.
 */
export function createGitHubTransport(env: NodeJS.ProcessEnv = process.env): {
  transport: RestTransport;
  fixtureDir: string | null;
} {
  const apiUrl = (env.DRAFTHOUSE_GITHUB_API ?? "https://api.github.com").replace(/\/+$/, "");
  const fixtureDir = env.DRAFTHOUSE_GITHUB_FIXTURE ?? null;
  if (fixtureDir) {
    try {
      return { transport: new FixtureTransport(loadFixturePairs(fixtureDir)), fixtureDir };
    } catch {
      return { transport: new GitHubFetchTransport(apiUrl), fixtureDir };
    }
  }
  return { transport: new GitHubFetchTransport(apiUrl), fixtureDir: null };
}

/**
 * The transport the daemon uses outside tests. Response headers ride along
 * because verifyPullRequestAccess reads a classic token's scopes out of
 * x-oauth-scopes.
 */
class GitHubFetchTransport implements RestTransport {
  constructor(private readonly apiUrl: string) {}

  async request(input: {
    method: "GET" | "POST" | "PUT" | "PATCH";
    url: string;
    headers: Record<string, string>;
    body?: Uint8Array;
  }): Promise<{ status: number; body: Uint8Array; headers: Record<string, string> }> {
    const response = await fetch(`${this.apiUrl}${input.url}`, {
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
 * merged is checked FIRST: GitHub reports a merged pull request as
 * `state: "closed"` with `merged: true`, so reading `state` alone turns 반영됨
 * into 닫힘 and the next 저장 would keep pushing to a branch nobody reads.
 */
function stateOf(data: Record<string, any>): PullRequestRef["state"] {
  if (data.merged === true || typeof data.merged_at === "string") return "merged";
  return data.state === "open" ? "open" : "closed";
}

function refOf(data: Record<string, any>): Omit<PullRequestRef, "state"> {
  return {
    number: Number(data.number),
    url: String(data.html_url ?? ""),
    title: String(data.title ?? ""),
    branch: String(data.head?.ref ?? ""),
  };
}

/**
 * The API's own `message` (plus the per-field `errors` a 422 adds), never the
 * request: the token only ever rides in a header, and nothing from `headers`
 * reaches this text, so a failure the planner or Claude reads cannot carry it.
 */
function httpError(label: string, status: number, body: Uint8Array): string {
  const text = new TextDecoder().decode(body.subarray(0, 1000));
  let message = text.split("\n")[0] ?? "";
  try {
    const parsed = JSON.parse(text) as {
      message?: string;
      errors?: Array<{ message?: string; field?: string; code?: string }>;
    };
    const details = (parsed.errors ?? [])
      .map((error) => error.message ?? [error.field, error.code].filter(Boolean).join(" "))
      .filter(Boolean)
      .join("; ");
    message = [parsed.message ?? message, details].filter(Boolean).join(" — ");
  } catch {
    // Not JSON (a proxy's html error page); the first line is the best we have.
  }
  return `${label} 실패 (exit ${status}): ${message}`;
}
