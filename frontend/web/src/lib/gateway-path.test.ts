import { describe, expect, it } from "vitest";
import { hasDotSegment } from "./gateway-path";

describe("hasDotSegment", () => {
  it("passes ordinary paths, dots inside names and dots in the query", () => {
    expect(hasDotSegment("/api/work/tasks/01HX/comments")).toBe(false);
    expect(hasDotSegment("/api/work/files/report.v2.pdf/download")).toBe(false);
    expect(hasDotSegment("/api/work/files/..a/download")).toBe(false);
    expect(hasDotSegment("/api/search?q=../x")).toBe(false);
  });
  it("catches dot segments, encoded or behind a backslash", () => {
    expect(hasDotSegment("/api/work/files/a/../../identity/x/download")).toBe(true);
    expect(hasDotSegment("/api/work/files/%2e%2E/download")).toBe(true);
    expect(hasDotSegment("/api/work/files/.%2e/download")).toBe(true);
    expect(hasDotSegment("/api/work/./x")).toBe(true);
    expect(hasDotSegment("/api/work/files/a\\..\\b")).toBe(true);
  });
});
