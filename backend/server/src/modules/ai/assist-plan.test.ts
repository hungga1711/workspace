import { describe, expect, it } from "vitest";
import { freeToday, rankTasks, slotTasks, type PlanTask } from "./assist-plan.js";

const TZ = "Asia/Ho_Chi_Minh";
// Tuesday 17 November 2026, 10:00 in Hồ Chí Minh City.
const NOW = Date.parse("2026-11-17T03:00:00Z");
const task = (code: string, more: Partial<PlanTask> = {}): PlanTask => ({ id: code, code, title: code, status: "todo", dueAt: null, ...more });

describe("plan_my_day order", () => {
  it("late first, then due today, at risk, tomorrow, urgent, started; blocked apart; done left out", () => {
    const { order, blocked } = rankTasks(
      [
        task("OPEN"),
        task("STARTED", { status: "in_progress" }),
        task("URGENT", { priority: "urgent" }),
        task("TOMORROW", { dueAt: "2026-11-18T09:00:00Z" }),
        task("RISK", { dueAt: "2026-11-25T09:00:00Z", atRisk: true }),
        task("TODAY", { dueAt: "2026-11-17T10:00:00Z" }),
        task("LATE", { dueAt: "2026-11-14T10:00:00Z" }),
        task("BLOCKED", { blockedReason: "waiting for legal", dueAt: "2026-11-10T10:00:00Z" }),
        task("DONE", { status: "done", dueAt: "2026-11-01T10:00:00Z" }),
      ],
      NOW,
      TZ,
    );
    expect(order.map((r) => r.task.code)).toEqual(["LATE", "TODAY", "RISK", "TOMORROW", "URGENT", "STARTED", "OPEN"]);
    expect(order[0]).toMatchObject({ why: "overdue", late: 3 });
    expect(blocked.map((b) => b.code)).toEqual(["BLOCKED"]);
  });

  it("within a group: more urgent and already started come first", () => {
    const due = "2026-11-17T09:00:00Z";
    const { order } = rankTasks(
      [task("A", { dueAt: due, priority: "low" }), task("B", { dueAt: due, priority: "high" }), task("C", { dueAt: due, status: "in_progress", priority: "low" })],
      NOW,
      TZ,
    );
    expect(order.map((r) => r.task.code)).toEqual(["B", "C", "A"]);
  });

  it("free stretches from now to the end of the shift, around meetings, 30 minutes at least", () => {
    const at = (hm: string) => Date.parse(`2026-11-17T${hm}:00+07:00`);
    const free = freeToday(NOW, TZ, { start: "09:00", end: "17:30" }, [
      { start: at("09:00"), end: at("10:30") },
      { start: at("11:00"), end: at("11:20") },
      { start: at("13:00"), end: at("14:00") },
      { start: at("13:30"), end: at("15:00") },
    ]);
    const hm = (n: number) => new Date(n).toLocaleTimeString("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
    expect(free.map((f) => `${hm(f.start)}-${hm(f.end)}`)).toEqual(["10:30-11:00", "11:20-13:00", "15:00-17:30"]);
    expect(freeToday(NOW, TZ, null, [])).toEqual([]);
    expect(freeToday(at("18:00"), TZ, { start: "09:00", end: "17:30" }, [])).toEqual([]);
  });

  it("the first task gets the longest free stretch", () => {
    const { order } = rankTasks([task("LATE", { dueAt: "2026-11-14T10:00:00Z" }), task("OPEN")], NOW, TZ);
    const slots = slotTasks(order, [
      { start: 0, end: 30 * 60_000 },
      { start: 100 * 60_000, end: 250 * 60_000 },
    ]);
    expect(slots.get("LATE")).toEqual({ start: 100 * 60_000, end: 250 * 60_000 });
    expect(slots.get("OPEN")).toEqual({ start: 0, end: 30 * 60_000 });
  });
});
