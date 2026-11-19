import { describe, expect, it } from "vitest";
import {
  AI_MIN_GROUP,
  AI_MIN_SAMPLE,
  aiComparison,
  aiWeek,
  approvalQueue,
  todayItems,
  dayOffset,
  deptBars,
  homeRole,
  needsReview,
  planHome,
  waited,
  weekItems,
  type PendingApproval,
} from "./model";

const now = Date.parse("2026-10-16T09:00:00Z");
const hoursAgo = (h: number) => new Date(now - h * 3600_000).toISOString();

describe("homeRole", () => {
  it("gives the manager Home only to people who follow a team", () => {
    expect(homeRole("reports")).toBe("manager");
    expect(homeRole("everyone")).toBe("manager");
    expect(homeRole("none")).toBe("staff");
    expect(homeRole(undefined)).toBe("staff");
    expect(homeRole("something-new")).toBe("staff");
  });
});

describe("approvals", () => {
  const a = (id: string, over: Partial<PendingApproval> = {}): PendingApproval => ({
    id,
    kind: "purchase",
    title: id,
    requesterId: "u",
    createdAt: hoursAgo(1),
    amount: null,
    currency: null,
    source: "work",
    ...over,
  });

  it("puts leave starting within two days first, then the longest wait", () => {
    const q = approvalQueue([a("new", { createdAt: hoursAgo(2) }), a("old", { createdAt: hoursAgo(48) }), a("leave", { kind: "leave", startsOn: "2026-10-17", source: "leave" })], {
      now,
    });
    expect(q.rows.map((r) => r.id)).toEqual(["leave", "old", "new"]);
    expect(q.oldestAt).toBe(hoursAgo(48));
  });

  it("shows four rows, counts the rest and totals the money", () => {
    const items = Array.from({ length: 6 }, (_, i) => a(`r${i}`, { createdAt: hoursAgo(10 - i), amount: 1_000_000 * (i + 1), currency: "VND" }));
    const q = approvalQueue(items, { now });
    expect(q.count).toBe(6);
    expect(q.rows).toHaveLength(4);
    expect(q.more).toBe(2);
    expect(q.totals).toEqual([{ currency: "VND", amount: 21_000_000 }]);
    expect(approvalQueue([a("v", { amount: 5, currency: "VND" }), a("u", { amount: 9, currency: "USD" })], { now }).totals).toEqual([
      { currency: "USD", amount: 9 },
      { currency: "VND", amount: 5 },
    ]);
    expect(approvalQueue([a("x")], { now }).totals).toEqual([]);
  });

  it("asks to open big amounts before deciding (threshold inclusive, adjustable)", () => {
    expect(needsReview({ amount: 50_000_000, currency: "VND" })).toBe(true);
    expect(needsReview({ amount: 49_999_999, currency: "VND" })).toBe(false);
    expect(needsReview({ amount: null, currency: null })).toBe(false);
    expect(needsReview({ amount: 2_000, currency: "USD" })).toBe(true);
    expect(needsReview({ amount: 2_000, currency: "XXX" })).toBe(false);
    const q = approvalQueue([a("big", { amount: 165_000_000, currency: "VND" }), a("small", { amount: 12_000_000, currency: "VND" })], { now, threshold: 10_000_000 });
    expect(q.rows.every((r) => r.review)).toBe(true);
  });

  it("says how long a request waited in its largest unit", () => {
    expect(waited(hoursAgo(0.2), now)).toEqual({ unit: "minutes", count: 12 });
    expect(waited(hoursAgo(18), now)).toEqual({ unit: "hours", count: 18 });
    expect(waited(hoursAgo(50), now)).toEqual({ unit: "days", count: 2 });
  });
});

describe("this week", () => {
  it("links each number to its Tiến độ view", () => {
    const [done, late, blocked, ai] = weekItems({ done7: 13, overdue: 7, blocked: 3 }, { totals: { people: 11, active: 8 } });
    expect(done).toMatchObject({ value: 13, href: "/app/ai/progress" });
    expect(late).toMatchObject({ value: 7, href: "/app/ai/progress" });
    expect(blocked).toMatchObject({ value: 3, href: "/app/ai/progress" });
    expect(ai).toMatchObject({ value: 8, of: 11, href: "/app/ai/adoption/usage" });
  });

  it("hides the AI line for small groups and when there is no AI data", () => {
    expect(aiWeek(null)).toBeNull();
    expect(aiWeek({ totals: { people: AI_MIN_GROUP - 1, active: 3 } })).toBeNull();
    expect(aiWeek({ totals: { people: 20, active: 0, prompts: 0 }, weekly: [{ people: 0 }, { people: 0 }] })).toBeNull();
    expect(aiWeek({ totals: { people: AI_MIN_GROUP, active: 1 } })).toMatchObject({ value: 1, of: AI_MIN_GROUP });
    expect(weekItems({ done7: 0, overdue: 0, blocked: 0 }, { totals: { people: 3, active: 3 } })).toHaveLength(3);
  });
});

describe("the cards", () => {
  const tz = "Asia/Ho_Chi_Minh";
  // 16:00 in Hà Nội.
  const at = (h: number) => new Date(now + h * 3600_000).toISOString();
  const task = (id: string, dueAt: string | null, status = "todo") => ({ id, title: id, dueAt, status });
  const meeting = (key: string, from: number, to: number) => ({ key, kind: "meeting" as const, at: at(from), endsAt: at(to) });

  it("splits my work into overdue, due later today and after today", () => {
    const d = planHome(
      { approvals: [], meetings: [], mentions: [], tasks: [task("later", at(48)), task("late", at(-30)), task("today", at(3)), task("none", null), task("gone", at(1), "done")] },
      { tz, now },
    );
    expect(d.late.map((x) => x.id)).toEqual(["late"]);
    expect(d.today.map((x) => x.id)).toEqual(["today"]);
    expect(d.upcoming.map((x) => x.id)).toEqual(["later", "none"]);
  });

  it("orders today's meetings by time, drops what ended, and offers Vào họp on the next meeting", () => {
    const d = planHome({ approvals: [], mentions: [], tasks: [], meetings: [meeting("late", 4, 5), meeting("past", -3, -2), meeting("soon", 1, 2)] }, { tz, now });
    expect(d.meetings.map((x) => x.key)).toEqual(["soon", "late"]);
    expect(d.joinKey).toBe("soon");
  });

  it("puts the newest mention first", () => {
    const mentions = [0, 2, 1].map((h) => ({ key: `m${h}`, at: at(-h) }));
    expect(planHome({ approvals: [], meetings: [], tasks: [], mentions }, { tz, now }).mentions.map((m) => m.key)).toEqual(["m0", "m1", "m2"]);
  });
});

describe("deptBars", () => {
  it("keeps departments with late work, worst first, bars relative to the worst", () => {
    const bars = deptBars([
      { name: "Sales", overdue: 4, open: 10 },
      { name: "Ops", overdue: 0, open: 3 },
      { name: null, overdue: 8, open: 9 },
      { name: "Design", overdue: 1, open: 2 },
    ]);
    expect(bars).toEqual([
      { name: null, overdue: 8, share: 100 },
      { name: "Sales", overdue: 4, share: 50 },
      { name: "Design", overdue: 1, share: 13 },
    ]);
    expect(deptBars([{ name: "A", overdue: 0, open: 1 }])).toEqual([]);
  });
});

describe("dayOffset", () => {
  it("counts calendar days in the workspace's zone", () => {
    expect(dayOffset("2026-10-16T16:59:00Z", "Asia/Ho_Chi_Minh", now)).toBe(0);
    expect(dayOffset("2026-10-16T17:01:00Z", "Asia/Ho_Chi_Minh", now)).toBe(1);
    expect(dayOffset("2026-10-14T09:00:00Z", "Asia/Ho_Chi_Minh", now)).toBe(-2);
  });
});

describe("todayItems", () => {
  const p = (id: string, overdue: number, blocked = 0, stale = 0) => ({ userId: id, displayName: id, overdue, blocked, stale, reason: null });
  it("ranks the most stuck person first, then waiting, then the safety alert, at most three", () => {
    const items = todayItems({
      people: [p("a", 1), p("b", 4, 1), p("c", 2)],
      waiting: { pipeline: 1, approvals: 2, href: "/x" },
      safety: { blocked: 1, redacted: 0, warned: 0 },
    });
    expect(items.map((i) => i.kind)).toEqual(["stuck", "waiting", "sensitive"]);
    expect(items[0]).toMatchObject({ person: { userId: "b" } });
  });
  it("fills free slots with the next stuck people and skips people with nothing late or blocked", () => {
    const items = todayItems({ people: [p("a", 1), p("b", 4), p("z", 0, 0, 5)], waiting: { pipeline: 0, approvals: 0, href: "/x" }, safety: null });
    expect(items.map((i) => (i.kind === "stuck" ? i.person.userId : i.kind))).toEqual(["b", "a"]);
  });
  it("never reads as all clear when a source failed", () => {
    expect(todayItems({ people: null, waiting: null, safety: null }).map((i) => i.kind)).toEqual(["failed", "failed"]);
  });
});

describe("aiComparison", () => {
  const g = (done: number, dated: number, onTime: number) => ({ done, dated, onTime });
  it("compares on-time rates only with enough tasks in both groups", () => {
    expect(aiComparison({ assisted: g(25, AI_MIN_SAMPLE, 18), other: g(40, 30, 15) })?.rates).toEqual({ withAi: 90, without: 50 });
    expect(aiComparison({ assisted: g(5, 5, 5), other: g(40, 30, 15) })).toEqual({ withAi: 5, without: 40, rates: null });
    expect(aiComparison(null)).toBeNull();
  });
});
