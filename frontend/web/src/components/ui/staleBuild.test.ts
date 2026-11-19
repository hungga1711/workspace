import { describe, expect, it } from "vitest";
import { isStaleBuildError, shouldReload } from "./staleBuild";

describe("isStaleBuildError", () => {
  it("knows webpack's chunk errors", () => {
    expect(isStaleBuildError({ name: "ChunkLoadError", message: "x" })).toBe(true);
    expect(isStaleBuildError({ name: "Error", message: "Loading chunk 9003 failed.\n(error: http://h/_next/static/chunks/9003-4ef2.js)" })).toBe(true);
    expect(isStaleBuildError({ name: "Error", message: "Loading CSS chunk app/layout failed." })).toBe(true);
  });
  it("leaves other errors to the screen", () => {
    expect(isStaleBuildError({ name: "TypeError", message: "i is not a function" })).toBe(false);
    expect(isStaleBuildError(null)).toBe(false);
  });
});

describe("shouldReload", () => {
  it("reloads once, then not again within a minute", () => {
    expect(shouldReload(1_000_000, null)).toBe(true);
    expect(shouldReload(1_000_000, 1_000_000 - 5_000)).toBe(false);
    expect(shouldReload(1_000_000, 1_000_000 - 61_000)).toBe(true);
  });
});
