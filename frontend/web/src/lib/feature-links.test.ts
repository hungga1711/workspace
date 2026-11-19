import { describe, expect, it } from "vitest";
import { featureOfHref } from "./feature-links";

describe("featureOfHref", () => {
  it("names the optional feature an address belongs to", () => {
    expect(featureOfHref("/app/ai")).toBe("ai");
    expect(featureOfHref("/app/ai/ask?c=1")).toBe("ai");
    expect(featureOfHref("/app/time?tab=leave&new=leave")).toBe("time");
    expect(featureOfHref("/app/work?tab=docs&new=page")).toBe("docs");
    expect(featureOfHref("/app/work/docs/D-001")).toBe("docs");
    expect(featureOfHref("/app/work?tab=whiteboards")).toBe("whiteboards");
    expect(featureOfHref("/app/work/whiteboards/W-001")).toBe("whiteboards");
    expect(featureOfHref("/app/work?tab=calendar&view=meetings")).toBe("calendar");
    expect(featureOfHref("/app/work/meetings/M-001")).toBe("calendar");
    expect(featureOfHref("/app/work/docs?view=files")).toBe("docs");
    expect(featureOfHref("/app/work/whiteboards?scope=mine")).toBe("whiteboards");
    expect(featureOfHref("/app/work/calendar?view=meetings")).toBe("calendar");
  });

  it("leaves chat, tasks, requests and the rest alone", () => {
    for (const href of [
      "/app/home",
      "/app/chat",
      "/app/work?tab=tasks",
      "/app/work?tab=ops",
      "/app/work/tasks",
      "/app/work/ops",
      "/app/work/goals",
      "/app/work/tasks/T-1",
      "/app/me",
      "/app/search?type=message",
      "/admin/workspace",
      "/app/aircraft",
      "/app/timesheet",
    ])
      expect(featureOfHref(href), href).toBeNull();
  });
});
