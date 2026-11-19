import { describe, expect, it } from "vitest";
import { formatMentions } from "./names";

describe("formatMentions", () => {
  it("reads a markdown table as rows of cells, without the rule line", () => {
    const md = "Expense policy\n| Expense | Limit |\n|---|---|\n| Team lunch | £25 per person |\nSubmit receipts.";
    expect(formatMentions(md, {})).toBe("Expense policy · Expense, Limit · Team lunch, £25 per person · Submit receipts.");
  });
  it("still names mentions", () => {
    expect(formatMentions("hi <@u1>", { u1: "Lan" })).toBe("hi @Lan");
  });
});
