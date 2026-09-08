/**
 * Fake data for ExampleList. This is the file a developer replaces with the
 * real API call, so everything the screen displays comes from here and the
 * screen itself holds no data literals.
 */
export type ExampleStatus = "active" | "paused" | "closed";

export interface ExampleRow {
  id: string;
  name: string;
  owner: string;
  status: ExampleStatus;
  updatedAt: string;
}

export const statusLabels: Record<ExampleStatus, string> = {
  active: "진행중",
  paused: "보류",
  closed: "종료",
};

export const rows: ExampleRow[] = [
  { id: "EX-1041", name: "여름 프로모션", owner: "김하늘", status: "active", updatedAt: "2026-09-07" },
  { id: "EX-1040", name: "신규 회원 쿠폰", owner: "이도윤", status: "active", updatedAt: "2026-09-05" },
  { id: "EX-1039", name: "주말 배송 안내", owner: "박서연", status: "paused", updatedAt: "2026-09-02" },
  { id: "EX-1038", name: "리뷰 이벤트", owner: "최민준", status: "closed", updatedAt: "2026-08-29" },
  { id: "EX-1037", name: "앱 푸시 A/B", owner: "정유진", status: "active", updatedAt: "2026-08-28" },
  { id: "EX-1036", name: "장바구니 리마인드", owner: "김하늘", status: "paused", updatedAt: "2026-08-24" },
  { id: "EX-1035", name: "재입고 알림", owner: "이도윤", status: "closed", updatedAt: "2026-08-21" },
  { id: "EX-1034", name: "첫 구매 감사", owner: "박서연", status: "active", updatedAt: "2026-08-19" },
];

export const totalPages = 4;
