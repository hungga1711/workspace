import { describe, expect, it } from "vitest";
import { aiUsersSql, aiWindow, AUTOMATIC_FEATURES, usesAi, workTokens } from "./metrics.js";

describe("AI metrics shared by Home, Adoption, the weekly report and Usage", () => {
  it("accepts only the offered windows", () => {
    expect(aiWindow("7")).toBe(7);
    expect(aiWindow(90)).toBe(90);
    expect(aiWindow("14")).toBe(30);
    expect(aiWindow(undefined, 7)).toBe(7);
  });

  it("counts someone as using AI for prompts or the app's own AI actions", () => {
    expect(usesAi({ prompts: 0, inAppCalls: 0 })).toBe(false);
    expect(usesAi({ prompts: 3, inAppCalls: 0 })).toBe(true);
    expect(usesAi({ prompts: 0, inAppCalls: 1 })).toBe(true);
  });

  it("builds one query for both sources, leaving automatic calls and the assistant's double count out", () => {
    const sql = aiUsersSql(7);
    expect(sql).toContain("FROM ai_conversations");
    expect(sql).toContain("FROM ai_hourly_stats");
    // The last 7 calendar days in the workspace zone, today included.
    expect(sql).toContain("make_interval(days => 6)");
    expect(sql).toContain("date_trunc('day', now() AT TIME ZONE");
    for (const f of ["assistant", ...AUTOMATIC_FEATURES]) expect(sql).toContain(`'${f}'`);
  });

  it("leaves cache reads out of headline tokens", () => {
    expect(workTokens({ input: 10, output: 5, cacheWrite: 2 })).toBe(17);
  });
});
