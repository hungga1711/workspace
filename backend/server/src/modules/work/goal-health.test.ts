import { describe, expect, it } from "vitest";
import { assessGoal, assessKr, krDirection, krMet, numberProgress, paceHealth, periodFacts, projectHealth } from "./goal-health.js";

// Q4/2026 in Vietnam time; "mid" is about half way through.
const STARTS = "2026-10-01";
const ENDS = "2027-01-01";
const mid = Date.parse("2026-11-15T05:00:00Z");
const early = Date.parse("2026-10-16T05:00:00Z");
const period = (now: number) => periodFacts(STARTS, ENDS, now);

describe("key result direction", () => {
  it("reads lower-is-better from the numbers unless stored", () => {
    expect(krDirection({ start: 900, target: 300 })).toBe("down");
    expect(krDirection({ start: 0, target: 30 })).toBe("up");
    expect(krDirection({ start: 0, target: 300, direction: "down" })).toBe("down");
    expect(krDirection({ start: 900, target: 300, direction: null })).toBe("down");
  });

  it("knows when a target is met, either way round", () => {
    expect(krMet({ start: 900, target: 300, current: 520 })).toBe(false);
    expect(krMet({ start: 900, target: 300, current: 280 })).toBe(true);
    expect(krMet({ start: 0, target: 12, current: 12 })).toBe(true);
    expect(krMet({ start: 0, target: 12, current: 3 })).toBe(false);
  });

  it("computes progress for lower-is-better key results", () => {
    expect(numberProgress({ start: 900, target: 300, current: 520 })).toBe(63);
    expect(numberProgress({ start: 45, target: 30, current: 38 })).toBe(47);
    expect(numberProgress({ start: 45, target: 30, current: 50 })).toBe(0); // got worse
    expect(numberProgress({ start: 900, target: 300, current: 250 })).toBe(100);
    // No usable start: how close the value is to the target.
    expect(numberProgress({ start: 0, target: 300, current: 600, direction: "down" })).toBe(50);
    expect(numberProgress({ start: 0, target: 300, current: 200, direction: "down" })).toBe(100);
  });

  it("computes progress for higher-is-better key results", () => {
    expect(numberProgress({ start: 0, target: 2000, current: 500 })).toBe(25);
    expect(numberProgress({ start: 30, target: 45, current: 50 })).toBe(100);
  });
});

describe("pace", () => {
  it("compares progress with time gone", () => {
    expect(paceHealth(50, 50)).toBe("on_track");
    expect(paceHealth(30, 50)).toBe("at_risk");
    expect(paceHealth(10, 50)).toBe("behind");
    expect(paceHealth(100, 50)).toBe("done");
    expect(paceHealth(90, 100, true)).toBe("behind");
  });
});

describe("project health (one rule everywhere)", () => {
  const now = Date.parse("2026-10-16T05:00:00Z");
  const base = { totalTasks: 11, doneTasks: 3, openTasks: 8, overdueTasks: 0, blockedTasks: 0, dueAt: new Date(now + 10 * 86400_000) };
  it("is on track with nothing late", () => {
    expect(projectHealth(base, now)).toMatchObject({ health: "on_track", progress: 27, daysLeft: 10 });
  });
  it("is at risk with late or blocked tasks, behind with more than two late", () => {
    expect(projectHealth({ ...base, overdueTasks: 2 }, now)).toMatchObject({ health: "at_risk", late: 2, daysLeft: 10 });
    expect(projectHealth({ ...base, blockedTasks: 1 }, now).health).toBe("at_risk");
    expect(projectHealth({ ...base, overdueTasks: 3 }, now).health).toBe("behind");
  });
  it("is behind past its due date with work open; done or not started otherwise", () => {
    expect(projectHealth({ ...base, dueAt: new Date(now - 86400_000) }, now).health).toBe("behind");
    expect(projectHealth({ ...base, openTasks: 0, doneTasks: 11 }, now).health).toBe("done");
    expect(projectHealth({ ...base, totalTasks: 0, openTasks: 0, doneTasks: 0 }, now).health).toBe("not_started");
  });
});

describe("goal health", () => {
  it("flags a goal whose project has late tasks even when its pace is fine", () => {
    const now = early;
    const project = { totalTasks: 11, doneTasks: 3, openTasks: 8, overdueTasks: 2, blockedTasks: 0, dueAt: new Date(now + 10 * 86400_000) };
    const kr = assessKr({ kind: "project", project }, period(now), now);
    expect(kr).toMatchObject({ progress: 27, health: "at_risk", reason: { kind: "project", late: 2, daysLeft: 10 } });
    const g = assessGoal(27, [kr], STARTS, ENDS, now);
    expect(g.health).toBe("at_risk");
    expect(g.reason).toEqual({ kind: "project", late: 2, blocked: 0, daysLeft: 10 });
  });

  it("is as bad as its worst key result", () => {
    const fine = assessKr({ kind: "number", start: 0, target: 10, current: 9 }, period(mid), mid);
    const slow = assessKr({ kind: "number", start: 900, target: 300, current: 850 }, period(mid), mid); // 8% at ~50% gone
    expect(fine.health).toBe("on_track");
    expect(slow.health).toBe("behind");
    const g = assessGoal(Math.round((fine.progress + slow.progress) / 2), [fine, slow], STARTS, ENDS, mid);
    expect(g.health).toBe("behind");
    expect(g.reason).toMatchObject({ kind: "pace" });
  });

  it("is on track only when every key result is", () => {
    const a = assessKr({ kind: "number", start: 900, target: 300, current: 520 }, period(mid), mid); // 63%
    const b = assessKr({ kind: "number", start: 0, target: 12, current: 6 }, period(mid), mid); // 50%
    expect(assessGoal(57, [a, b], STARTS, ENDS, mid)).toMatchObject({ health: "on_track", reason: null });
  });

  it("is done when every key result is met, behind when the period ended short", () => {
    const met = assessKr({ kind: "number", start: 900, target: 300, current: 290 }, period(mid), mid);
    expect(assessGoal(100, [met], STARTS, ENDS, mid).health).toBe("done");
    const after = Date.parse("2027-01-05T05:00:00Z");
    const short = assessKr({ kind: "number", start: 0, target: 12, current: 11 }, period(after), after);
    expect(short).toMatchObject({ health: "behind", reason: { kind: "ended" } });
    expect(assessGoal(92, [short], STARTS, ENDS, after).health).toBe("behind");
  });

  it("has not started before its period", () => {
    const kr = assessKr({ kind: "number", start: 0, target: 12, current: 0 }, period(Date.parse("2026-09-01T00:00:00Z")), Date.parse("2026-09-01T00:00:00Z"));
    expect(assessGoal(0, [kr], STARTS, ENDS, Date.parse("2026-09-01T00:00:00Z")).health).toBe("not_started");
  });
});
