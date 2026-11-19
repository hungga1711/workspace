import { describe, expect, it } from "vitest";
import { stepRoute, stepSystem } from "./assist.js";

describe("a workflow step's model and system prompt", () => {
  it("reads the step's model choice as a tier and a route", () => {
    expect(stepRoute(undefined)).toEqual({ tier: "smart", route: undefined });
    expect(stepRoute("fast")).toEqual({ tier: "fast", route: undefined });
    expect(stepRoute("c_1:qwen3:8b")).toEqual({ tier: "smart", route: "c_1:qwen3:8b" });
  });
  it("adds the step's role after the pipeline's rules", () => {
    expect(stepSystem("Vietnamese", "")).not.toContain("role");
    expect(stepSystem("Vietnamese", " An editor. ")).toMatch(/in Vietnamese\.[\s\S]*Your role for this step:\nAn editor\.$/);
  });
});
