import { describe, expect, it } from "vitest";
import { channelLabel, fingerprint, isPrivateKey, scrub, scrubRecord } from "./privacy.js";

describe("audit privacy filter", () => {
  it("strips content, prompts and secrets at any depth, whatever their casing", () => {
    const out = scrubRecord({
      status: "doing",
      body: "Lương tháng này của Lan là…",
      description: "khách hàng ABC",
      nested: { previewText: "x", clientSecret: "s3cr3t", apiKey: "wos_123", password: "p", prompt: "hãy viết", answer: "đây", note: "lý do riêng", ok: 1 },
      comments: [{ comment: "hi", commentId: "c1" }],
      query: "lương",
      q: "lương",
      topic: "kênh bí mật",
      content: "<p>trang</p>",
      transcript: "...",
      toolCalls: [{ input: { a: 1 } }],
    });
    expect(out).toEqual({ status: "doing", nested: { ok: 1 }, comments: [{ commentId: "c1" }] });
    expect(JSON.stringify(out)).not.toMatch(/Lương|ABC|s3cr3t|wos_|hãy viết|lý do|bí mật|trang/);
  });

  it("keeps ids whose names end in a private word", () => {
    expect(isPrivateKey("messageId")).toBe(false);
    expect(isPrivateKey("commentIds")).toBe(false);
    expect(isPrivateKey("message_id")).toBe(false);
    expect(isPrivateKey("bodyText")).toBe(true);
    expect(isPrivateKey("secretChanged")).toBe(true);
  });

  it("clips long strings and bounds arrays and depth", () => {
    const long = "a".repeat(500);
    const s = scrub({ name: long, list: Array.from({ length: 80 }, (_, i) => i), deep: { a: { b: { c: { d: { e: 1 } } } } } }) as Record<string, unknown>;
    expect((s.name as string).length).toBeLessThanOrEqual(201);
    expect((s.list as number[]).length).toBe(50);
    expect(JSON.stringify(s.deep)).not.toContain('"e"');
  });

  it("fingerprints say a value changed without keeping it", () => {
    expect(fingerprint("secret plan")).not.toContain("secret");
    expect(fingerprint("a")).not.toBe(fingerprint("b"));
    expect(fingerprint("")).toBeNull();
  });

  it("names only public channels", () => {
    expect(channelLabel("public", "general")).toBe("#general");
    expect(channelLabel("private", "hr-salaries")).toBeNull();
    expect(channelLabel("dm", null)).toBeNull();
  });
});
