import { describe, expect, it } from "vitest";
import { DEPLOY_FEATURES, deployFeatureMap, disabledFeatures, featureDisabled, parseDisabledFeatures } from "./deploy-features.js";

describe("DISABLED_FEATURES", () => {
  it("switches nothing off when unset or empty", () => {
    for (const raw of [undefined, null, "", "  ", ","]) {
      const { disabled, unknown } = parseDisabledFeatures(raw);
      expect([...disabled]).toEqual([]);
      expect(unknown).toEqual([]);
    }
    expect(Object.values(deployFeatureMap({}))).toEqual(DEPLOY_FEATURES.map(() => true));
  });

  it("reads names separated by commas or spaces, in any case", () => {
    expect([...parseDisabledFeatures("whiteboards, Calendar  AI;docs\ntime").disabled].sort()).toEqual(["ai", "calendar", "docs", "time", "whiteboards"]);
  });

  it("accepts the names people write for a flag", () => {
    expect([...parseDisabledFeatures("whiteboard,attendance,documents").disabled].sort()).toEqual(["docs", "time", "whiteboards"]);
  });

  it("reports unknown names once and switches nothing off for them", () => {
    const { disabled, unknown } = parseDisabledFeatures("chat,tasks,chat,calendar");
    // Chat and tasks have no flag: asking to disable them is reported, not obeyed.
    expect([...disabled]).toEqual(["calendar"]);
    expect(unknown).toEqual(["chat", "tasks"]);
  });

  it("reads the process environment", () => {
    const env = { DISABLED_FEATURES: "ai" };
    expect(featureDisabled("ai", env)).toBe(true);
    expect(featureDisabled("docs", env)).toBe(false);
    expect([...disabledFeatures(env)]).toEqual(["ai"]);
    expect(deployFeatureMap(env)).toEqual({ docs: true, whiteboards: true, calendar: true, time: true, ai: false });
  });
});
