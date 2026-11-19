import { describe, expect, it } from "vitest";
import { PASSAGES_MAX, splitPassages } from "./search.js";

describe("splitPassages", () => {
  it("keeps a short text whole", () => {
    expect(splitPassages("Refunds within 30 days.")).toEqual([{ heading: "", body: "Refunds within 30 days." }]);
    expect(splitPassages("  \n ")).toEqual([]);
    expect(splitPassages("")).toEqual([]);
  });

  it("cuts a long text into passages of about a thousand characters, never mid-word", () => {
    const sentence = "The warehouse ships every order within two working days of payment. ";
    const pieces = splitPassages(Array.from({ length: 12 }, () => sentence.repeat(6).trim()).join("\n\n"));
    expect(pieces.length).toBeGreaterThan(3);
    for (const p of pieces) {
      expect(p.body.length).toBeLessThanOrEqual(1300);
      expect(p.body.length).toBeGreaterThan(100);
      expect(p.body.startsWith("The ") || p.body.startsWith("payment") === false).toBe(true);
      expect(/\w$|\.$/.test(p.body)).toBe(true);
    }
  });

  it("repeats the end of a passage at the start of the next, so a fact on the cut is in both", () => {
    const paras = Array.from({ length: 8 }, (_, i) => `Paragraph ${i} begins here. ${"Some filler words follow in this sentence. ".repeat(7)}It ends with marker${i}.`);
    const pieces = splitPassages(paras.join("\n\n"));
    const first = pieces[0]!.body;
    const marker = /marker\d/.exec(first.slice(-60))?.[0];
    expect(marker).toBeTruthy();
    expect(pieces[1]!.body.slice(0, 200)).toContain(marker!);
  });

  it("gives each passage the headings above it, and starts a new passage at a heading", () => {
    const body = "Plain words that say something about the rule in question. ".repeat(12).trim();
    const pieces = splitPassages(`# Handbook\n\n${body}\n\n## Refunds\n\n### After thirty days\n\nStore credit only.\n\n## Travel\n\n${body}`);
    expect(pieces[0]).toMatchObject({ heading: "Handbook" });
    const refund = pieces.find((p) => p.body.includes("Store credit only."))!;
    expect(refund).toEqual({ heading: "Handbook › Refunds › After thirty days", body: "Store credit only." });
    expect(pieces.at(-1)!.heading).toBe("Handbook › Travel");
    // A section never opens with the last sentence of the one before it.
    expect(pieces.find((p) => p.heading === "Handbook › Travel")!.body.startsWith("Plain words")).toBe(true);
  });

  it("treats a workbook's sheets and a deck's slides as sections", () => {
    const rows = Array.from({ length: 60 }, (_, i) => `Item ${i},${i * 10},EUR`).join("\n");
    const pieces = splitPassages(`Sheet: Prices\n${rows}\n\nSheet: Terms\nPayment,30 days`);
    expect(pieces[0]!.heading).toBe("Sheet: Prices");
    expect(pieces.at(-1)).toEqual({ heading: "Sheet: Terms", body: "Payment,30 days" });
  });

  it("splits one enormous paragraph and stops at the cap", () => {
    const pieces = splitPassages("word ".repeat(200_000));
    expect(pieces.length).toBe(PASSAGES_MAX);
    expect(pieces.every((p) => p.body.length <= 1300)).toBe(true);
  });
});
