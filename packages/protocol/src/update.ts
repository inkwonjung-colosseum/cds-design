/** 프로토콜 v3 — 수동 업데이트 확인(공유 로직, DESIGN §7). */
/**
 * 수동 업데이트 확인(v1): 릴리스 페이지(GitHub Releases)의 latest.json 과 현재 버전을 비교.
 * fetch 는 주입받는다 — 데스크톱은 Electron 의 net, 브라우저는 window.fetch,
 * 테스트는 로컬 fixture 서버. 자동 확인 타이머는 v1 범위 밖이다.
 *
 * 이 모듈은 순수 로직만 담아 데몬·웹·데스크톱이 한 곳에서 공유한다.
 */

// 릴리스 저장소("owner/repo"). GitHub Releases 가 곧 배포 채널이다(DESIGN §7
// 의 별도 releases 레포 대신 이 레포의 릴리스 페이지에 설치 파일을 올린다).
// ⚠️ GitHub 에 푸시한 뒤 이 값을 실제 주소로 바꿔야 업데이트 확인이 동작한다.
// 무인증 fetch 라 private repo 릴리스는 403/404 다 — 소스가 private 여도
// 설치 파일은 공개 상태여야 한다.
export const RELEASES_REPO = "OWNER/REPO";
export const RELEASES_FEED_URL = `https://github.com/${RELEASES_REPO}/releases/latest/download/latest.json`;

export interface LatestFeed {
  version: string;
  notes?: string;
  url?: string;
  /** mac zip 의 sha256(자가 교체 검증용), 선택. */
  sha256?: string;
}

export interface UpdateCheckResult {
  updateAvailable: boolean;
  version: string;
  notes: string | null;
  url: string | null;
}

export type FetchLike = (url: string) => Promise<{ ok: boolean; json?: unknown; status: number }>;

/**
 * semver 비교: -1 | 0 | 1. 사전릴리스는 v1 에선 그냥 문자열 비교로
 * 충분하다(공개 릴리스만 올린다).
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const parse = (version: string): [number, number, number] => {
    const [major = 0, minor = 0, patch = 0] = version
      .replace(/^v/, "")
      .split(".")
      .map((part) => Number.parseInt(part, 10) || 0);
    return [major, minor, patch];
  };
  const [aMajor, aMinor, aPatch] = parse(a);
  const [bMajor, bMinor, bPatch] = parse(b);
  if (aMajor !== bMajor) return aMajor < bMajor ? -1 : 1;
  if (aMinor !== bMinor) return aMinor < bMinor ? -1 : 1;
  if (aPatch !== bPatch) return aPatch < bPatch ? -1 : 1;
  return 0;
}

/** latest.json 을 내려받아 파싱한다 — 형식이 틀리면 한국어 오류. */
export async function fetchLatest(feedUrl: string, fetchLike: FetchLike): Promise<LatestFeed> {
  const response = await fetchLike(feedUrl);
  if (!response.ok) {
    throw new Error(`업데이트 정보를 가져오지 못했습니다 (exit ${response.status})`);
  }
  const parsed = response.json as Record<string, unknown> | undefined;
  if (!parsed || typeof parsed.version !== "string") {
    throw new Error("업데이트 정보 형식이 올바르지 않습니다");
  }
  return {
    version: parsed.version,
    notes: typeof parsed.notes === "string" ? parsed.notes : undefined,
    url: typeof parsed.url === "string" ? parsed.url : undefined,
    sha256: typeof parsed.sha256 === "string" ? parsed.sha256 : undefined,
  };
}

/** 확인 버튼 한 번의 전체 흐름: 받아서 비교해서 사람에게 보일 형태로. */
export async function checkForUpdate(
  currentVersion: string,
  feedUrl: string,
  fetchLike: FetchLike,
): Promise<UpdateCheckResult> {
  const latest = await fetchLatest(feedUrl, fetchLike);
  return {
    updateAvailable: compareSemver(currentVersion, latest.version) < 0,
    version: latest.version,
    notes: latest.notes ?? null,
    url: latest.url ?? null,
  };
}
