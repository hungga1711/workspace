import { describe, expect, it } from "vitest";
import { dayIn, freeSlots, managerChain, merge, directReports, tops, treeLines, zonedInstant, type OrgPerson } from "./people-plan.js";

const TZ = "Asia/Ho_Chi_Minh";
const at = (s: string) => Date.parse(s);
const iso = (n: number) => new Date(n).toISOString();

describe("zonedInstant", () => {
  it("reads wall time in the zone", () => {
    expect(iso(zonedInstant("2026-11-18", "09:00", TZ))).toBe("2026-11-18T02:00:00.000Z");
    expect(iso(zonedInstant("2026-07-01", "09:00", "Europe/London"))).toBe("2026-07-01T08:00:00.000Z");
    expect(iso(zonedInstant("2026-12-01", "09:00", "Europe/London"))).toBe("2026-12-01T09:00:00.000Z");
  });
  it("gives the local day", () => {
    expect(dayIn(at("2026-11-17T18:00:00Z"), TZ)).toBe("2026-11-18");
  });
});

describe("merge", () => {
  it("joins overlapping and touching intervals", () => {
    expect(
      merge([
        { start: 5, end: 8 },
        { start: 1, end: 3 },
        { start: 3, end: 4 },
        { start: 7, end: 9 },
      ]),
    ).toEqual([
      { start: 1, end: 4 },
      { start: 5, end: 9 },
    ]);
  });
});

describe("freeSlots", () => {
  const base = {
    tz: TZ,
    durationMin: 60,
    workWeek: [1, 2, 3, 4, 5],
    dayStart: "09:00",
    dayEnd: "17:00",
    closedDays: new Set<string>(),
    now: at("2026-11-01T00:00:00Z"),
  };
  // Wed 18 Nov 2026, Vietnam time.
  const from = at("2026-11-18T00:00:00+07:00");
  const to = at("2026-11-18T23:59:00+07:00");

  it("returns the gaps around busy time, within working hours", () => {
    const s = freeSlots({ ...base, from, to, busy: [{ start: at("2026-11-18T10:00:00+07:00"), end: at("2026-11-18T12:00:00+07:00") }], max: 5 });
    expect(s.map((x) => [iso(x.start), iso(x.end)])).toEqual([
      ["2026-11-18T02:00:00.000Z", "2026-11-18T03:00:00.000Z"],
      ["2026-11-18T05:00:00.000Z", "2026-11-18T10:00:00.000Z"],
    ]);
  });

  it("skips gaps shorter than the meeting and rounds starts to the quarter hour", () => {
    const s = freeSlots({
      ...base,
      from,
      to,
      busy: [
        { start: at("2026-11-18T09:30:00+07:00"), end: at("2026-11-18T10:05:00+07:00") },
        { start: at("2026-11-18T11:00:00+07:00"), end: at("2026-11-18T17:00:00+07:00") },
      ],
    });
    // 09:00–09:30 is too short; after 10:05 the next start is 10:15, and 10:15–11:00 is too short too.
    expect(s).toEqual([]);
  });

  it("skips weekends, holidays and away days, and the past", () => {
    const s = freeSlots({
      ...base,
      from: at("2026-11-20T00:00:00+07:00"), // Friday
      to: at("2026-11-24T23:00:00+07:00"), // Tuesday
      closedDays: new Set(["2026-11-23"]),
      busy: [],
      now: at("2026-11-20T15:20:00+07:00"),
    });
    expect(s.map((x) => dayIn(x.start, TZ))).toEqual(["2026-11-20", "2026-11-24"]);
    expect(iso(s[0]!.start)).toBe("2026-11-20T08:30:00.000Z"); // 15:30 local
  });

  it("offers at most two windows a day and `max` in all", () => {
    const busy = [10, 12, 14].map((h) => ({ start: at(`2026-11-18T${h}:00:00+07:00`), end: at(`2026-11-18T${h}:30:00+07:00`) }));
    expect(freeSlots({ ...base, from, to, busy, durationMin: 30 })).toHaveLength(2);
    expect(freeSlots({ ...base, from, to: at("2026-11-27T00:00:00+07:00"), busy: [], max: 3 })).toHaveLength(3);
  });
});

describe("org tree", () => {
  const people: OrgPerson[] = [
    { userId: "ceo", displayName: "An", title: "CEO", managerId: null },
    { userId: "cto", displayName: "Bình", title: "CTO", managerId: "ceo" },
    { userId: "dev1", displayName: "Chi", department: "Tech", managerId: "cto" },
    { userId: "dev2", displayName: "Dũng", department: "Tech", managerId: "cto" },
    { userId: "loop1", displayName: "X", managerId: "loop2" },
    { userId: "loop2", displayName: "Y", managerId: "loop1" },
  ];
  it("walks the manager chain nearest first and survives loops", () => {
    expect(managerChain(people, "dev1").map((p) => p.userId)).toEqual(["cto", "ceo"]);
    expect(managerChain(people, "loop1").map((p) => p.userId)).toEqual(["loop2"]);
  });
  it("lists direct reports by name", () => {
    expect(directReports(people, "cto").map((p) => p.displayName)).toEqual(["Chi", "Dũng"]);
  });
  it("draws the tree with a depth cap", () => {
    expect(treeLines(people, tops(people))).toEqual(["- An, CEO", "  - Bình, CTO", "    - Chi (Tech)", "    - Dũng (Tech)"]);
    expect(treeLines(people, [people[0]!], 2)).toEqual(["- An, CEO", "  - Bình, CTO [+2 more]"]);
  });
  it("caps the number of lines", () => {
    expect(treeLines(people, [people[0]!], 4, 2)).toEqual(["- An, CEO", "  - Bình, CTO", "… 2 more people"]);
  });
});
