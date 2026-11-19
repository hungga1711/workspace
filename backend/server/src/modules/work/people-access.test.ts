import { describe, expect, it } from "vitest";
import { departmentAccess, fullRow, personAccess, workNumbersOnly } from "./people-access.js";

const base = { callerId: "me", everyone: false, teamIds: new Set<string>(), callerDepartmentId: null, targetDepartmentId: null };

describe("personAccess", () => {
  it("always opens your own page", () => {
    expect(personAccess({ ...base, targetId: "me" })).toBe("self");
  });
  it("opens anyone for company followers", () => {
    expect(personAccess({ ...base, targetId: "x", everyone: true })).toBe("everyone");
  });
  it("opens your reporting line in full", () => {
    expect(personAccess({ ...base, targetId: "r1", teamIds: new Set(["r1"]) })).toBe("manager");
  });
  it("gives same-department colleagues the numbers", () => {
    expect(personAccess({ ...base, targetId: "c", callerDepartmentId: "d1", targetDepartmentId: "d1" })).toBe("colleague");
  });
  it("refuses everyone else, including two people with no department", () => {
    expect(personAccess({ ...base, targetId: "c", callerDepartmentId: "d1", targetDepartmentId: "d2" })).toBeNull();
    expect(personAccess({ ...base, targetId: "c" })).toBeNull();
  });
});

describe("departmentAccess", () => {
  const d = { callerId: "me", everyone: false, headId: null, teamIds: new Set<string>(), memberIds: ["a", "b"], callerDepartmentId: null, departmentId: "d1" };
  it("opens for company followers and the head", () => {
    expect(departmentAccess({ ...d, everyone: true })).toBe("everyone");
    expect(departmentAccess({ ...d, headId: "me" })).toBe("manager");
  });
  it("opens for a manager whose reports work there", () => {
    expect(departmentAccess({ ...d, teamIds: new Set(["b"]) })).toBe("manager");
  });
  it("gives members the numbers and refuses outsiders", () => {
    expect(departmentAccess({ ...d, callerDepartmentId: "d1" })).toBe("colleague");
    expect(departmentAccess({ ...d, callerDepartmentId: "d2" })).toBeNull();
  });
  it("shows a manager's own people in full and the rest as numbers", () => {
    const x = { callerId: "me", headId: null, teamIds: new Set(["b"]) };
    expect(fullRow("manager", { ...x, userId: "b" })).toBe(true);
    expect(fullRow("manager", { ...x, userId: "a" })).toBe(false);
    expect(fullRow("colleague", { ...x, userId: "me" })).toBe(true);
    expect(fullRow("manager", { ...x, headId: "me", userId: "a" })).toBe(true);
  });
});

describe("workNumbersOnly", () => {
  it("drops task titles, notes and blockers but keeps the figures", () => {
    const row = { open: 3, overdue: 1, now: [1], late: [1], doneRecently: [1], tasks: [1] };
    expect(workNumbersOnly(row)).toEqual({ open: 3, overdue: 1, now: [], late: [], doneRecently: [], tasks: [] });
  });
});
