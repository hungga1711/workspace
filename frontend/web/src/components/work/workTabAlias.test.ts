import { describe, expect, it } from "vitest";
import { legacyWorkHref, workTabOf } from "./workTabAlias";

const from = (q: string) => legacyWorkHref(new URLSearchParams(q));

describe("legacyWorkHref", () => {
  it("moves an old ?tab= link to the tab's own address, keeping its other parameters", () => {
    expect(from("tab=tasks")).toBe("/app/work/tasks");
    expect(from("tab=calendar&date=2024-03-15")).toBe("/app/work/calendar?date=2024-03-15");
    expect(from("tab=tasks&project=P1&view=list")).toBe("/app/work/tasks?project=P1&view=list");
    expect(from("tab=goals&period=2026-Q4")).toBe("/app/work/goals?period=2026-Q4");
  });

  it("turns removed sub-tabs into the view they are now", () => {
    expect(from("tab=projects&archived=1")).toBe("/app/work/tasks?archived=1&view=projects");
    expect(from("tab=files")).toBe("/app/work/docs?view=files");
    expect(from("tab=meetings&when=past")).toBe("/app/work/calendar?when=past&view=meetings");
    expect(from("tab=board&project=P1")).toBe("/app/work/tasks?project=P1");
    expect(from("tab=yeu-cau")).toBe("/app/work/ops");
  });

  it("opens Việc for no tab or an unknown one", () => {
    expect(from("")).toBe("/app/work/tasks");
    expect(from("new=task")).toBe("/app/work/tasks?new=task");
    expect(from("tab=nope")).toBe("/app/work/tasks");
  });
});

describe("workTabOf", () => {
  it("names the tab of a tab address only", () => {
    expect(workTabOf("/app/work/calendar")).toBe("calendar");
    expect(workTabOf("/app/work/tasks/")).toBe("tasks");
    expect(workTabOf("/app/work/tasks/T-1")).toBeNull();
    expect(workTabOf("/app/work")).toBeNull();
    expect(workTabOf("/app/work/people")).toBeNull();
  });
});
