import { describe, expect, it } from "vitest";
import { browserName, groupKey, isBenign, normalizeMessage, reportSchema } from "./client-errors.js";

describe("client errors: grouping", () => {
  it("puts the same error with different ids, numbers and quoted values in one group", () => {
    const a = groupKey("Cannot read properties of undefined (reading 'name')");
    const b = groupKey("Cannot read properties of undefined (reading 'title')");
    expect(a).toBe(b);
    expect(groupKey("task 01M61PJRW8GVZRF94VVYPM6YAP not found")).toBe(groupKey("task 01M6H6NR7S7JSYZQ14MCKRBWW9 not found"));
    expect(groupKey("HTTP 502 from http://a/x")).toBe(groupKey("HTTP 503 from http://b/y?z=1"));
  });

  it("keeps different errors apart and the key short and stable", () => {
    expect(groupKey("i is not a function")).not.toBe(groupKey("Cannot read properties of undefined"));
    expect(groupKey("  i is not a function \n")).toBe(groupKey("i is not a function"));
    expect(groupKey("x")).toMatch(/^[0-9a-f]{16}$/);
  });

  it("normalizes without eating the words", () => {
    expect(normalizeMessage("Loading chunk 42 failed: 'https://x/_next/a.js'")).toBe("Loading chunk <n> failed: <str>");
  });
});

describe("client errors: browser name", () => {
  it("names the common families and nothing else", () => {
    expect(browserName("Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36")).toBe("Chrome");
    expect(browserName("Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15")).toBe("Safari");
    expect(browserName("Mozilla/5.0 (Windows) Gecko/20100101 Firefox/131.0")).toBe("Firefox");
    expect(browserName("Mozilla/5.0 (Windows) Chrome/130.0 Safari/537.36 Edg/130.0")).toBe("Edge");
    expect(browserName("curl/8.0")).toBeNull();
    expect(browserName(null)).toBeNull();
  });
});

describe("client errors: report shape", () => {
  it("accepts the web app's report and refuses an unknown kind or a loose code", () => {
    const ok = reportSchema.safeParse({ code: "C-J453CWYO", kind: "boundary", message: "i is not a function", frames: [{ file: "src/a.tsx", line: 1, col: 2, name: null }] });
    expect(ok.success).toBe(true);
    expect(reportSchema.safeParse({ code: "c j", kind: "boundary", message: "x" }).success).toBe(false);
    expect(reportSchema.safeParse({ code: "C-1", kind: "panic", message: "x" }).success).toBe(false);
  });
});

describe("isBenign", () => {
  it("folds away browser noise and keeps real errors", () => {
    expect(isBenign("ResizeObserver loop completed with undelivered notifications.")).toBe(true);
    expect(isBenign("AbortError: The user aborted a request.")).toBe(true);
    expect(isBenign("TypeError: i is not a function")).toBe(false);
  });
});
