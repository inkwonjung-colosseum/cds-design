/**
 * The 넘기기 draft the browser contributes (PLAN D5): the screens this cycle
 * hands over, the states each one implements, and the pageId token the daemon
 * badges from.
 *
 * Run: node --experimental-transform-types --test packages/web/test/handoff-draft.test.mts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { handoffDraft } from "../src/handoff-draft.ts";

const PAGES: Record<string, string> = { "_acct/재고 실사 목록.md": "770412" };
const pageIdOf = (spec: string) => PAGES[spec] ?? null;

const screen = (over: Partial<Parameters<typeof handoffDraft>[1][number]> = {}) => ({
  route: "/inventory-audit/InventoryAuditList",
  title: "재고 실사 목록",
  states: ["default", "empty"],
  spec: "_acct/재고 실사 목록.md",
  ...over,
});

test("the draft tells the developer which states the mock actually implements", () => {
  const { body } = handoffDraft("재고 실사 화면", [screen()], pageIdOf);

  // §2.4 refuses to badge 인터랙션 완료 because judging it means reading the
  // 기획서. Handing the declared list over unjudged is what replaced it, and
  // the pull request is the only place a developer ever sees it.
  assert.match(body, /상태 default · empty/, body);
  assert.match(body, /재고 실사 목록/);
  assert.match(body, /\/inventory-audit\/InventoryAuditList/);
  // The token the daemon scans to badge the page ✓ 넘김.
  assert.match(body, /\(pageId: 770412\)/);
});

test("the draft names no screen it cannot tie to a 기획서", () => {
  // A screen whose spec is not one of this project's pages would contribute a
  // line the daemon cannot badge from — a hole, not information.
  const stranger = handoffDraft("결제", [screen({ spec: "OTHER/딴 기획서.md" })], pageIdOf);
  assert.equal(stranger.body, "");

  // Nothing declared at all: an empty field, so the daemon's own proposal
  // (which can list and link the 기획서 pages) is what gets sent.
  assert.equal(handoffDraft("결제", [], pageIdOf).body, "");
});

test("the draft does not say 화면 twice", () => {
  assert.equal(handoffDraft("재고 실사 화면", [], pageIdOf).title, "재고 실사 화면");
  assert.equal(handoffDraft("결제", [], pageIdOf).title, "결제 화면");
  assert.equal(handoffDraft("", [], pageIdOf).title, "");
});
