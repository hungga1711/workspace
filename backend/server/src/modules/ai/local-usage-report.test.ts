import { describe, expect, it } from "vitest";
import { buildTokenReport, priceOf, type TokenRow } from "./local-usage-report.js";

const row = (x: Partial<TokenRow>): TokenRow => ({
  userId: "u1",
  tool: "claude-code",
  model: "claude-sonnet-4-5-20250929",
  day: "2026-11-06",
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  turns: 1,
  sessions: 1,
  ...x,
});

describe("priceOf", () => {
  it("matches the most specific known prefix, and leaves unknown models unpriced", () => {
    expect(priceOf("claude-opus-4-1-20250805")?.input).toBe(15);
    expect(priceOf("claude-opus-4-5-20251101")?.input).toBe(5);
    expect(priceOf("gpt-5-codex")?.output).toBe(10);
    expect(priceOf("gpt-5-mini")?.input).toBe(0.25);
    expect(priceOf("some-new-model")).toBeNull();
  });
  it("prefers the company's own prices", () => {
    expect(priceOf("gpt-4.1-mini", [{ model: "gpt-4.1-mini", input: 9, output: 9 }])?.input).toBe(9);
  });
});

describe("buildTokenReport", () => {
  it("adds up the mix, prices local rows, keeps metered company cost and counts unpriced tokens", () => {
    const r = buildTokenReport(
      [
        row({ input: 1_000_000, output: 1_000_000, cacheRead: 2_000_000, cacheWrite: 0 }),
        row({ tool: "codex", model: "unknown-x", day: "2026-11-05", input: 500, output: 500 }),
        row({ userId: "u2", tool: "company", model: "gpt-4.1-mini", input: 100, output: 100, costUsd: 0.25 }),
        row({ day: "2026-10-01", input: 999 }),
      ],
      [{ userId: "u1", total: 10 }],
      7,
      "2026-11-06",
    );
    // Work tokens: the 2M cache reads stay in the mix, out of the total.
    expect(r.totals.total).toBe(2_000_000 + 1000 + 200);
    expect(r.totals.cacheRead).toBe(2_000_000);
    // The company AI's metered cost and the computers' list value are kept apart, never added.
    expect(r.totals.costUsd).toBeCloseTo(0.25, 5);
    // Sonnet 4: 3 input + 15 output + 2M cache read at 0.3.
    expect(r.totals.listValueUsd).toBeCloseTo(3 + 15 + 0.6, 5);
    expect(r.totals.unpricedTokens).toBe(1000);
    expect(r.totals.previous).toBe(10);
    expect(r.activeDays).toBe(2);
    expect(r.bestStreak).toBe(2);
    expect(r.daily).toHaveLength(7);
    expect(r.tools.map((t) => t.tool)).toEqual(["claude-code", "codex", "company"]);
    expect(r.models.find((m) => m.model === "unknown-x")?.costUsd).toBeNull();
    expect(r.people[0]).toMatchObject({ userId: "u1", previous: 10, activeDays: 2 });
    expect(r.cacheReuse).toBeCloseTo(2_000_000 / (2_000_000 + 1_000_600), 5);
  });
});
