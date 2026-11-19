import { describe, expect, it } from "vitest";
import { guessMapping, parseNumber, readTable, toImportRows } from "./ai-import";

describe("provider export import", () => {
  it("guesses common header names", () => {
    expect(guessMapping(["User Email", "Timestamp", "Product", "Model Name", "Conversation title", "Message count", "Total tokens", "Cost (USD)"])).toEqual({
      email: "User Email",
      at: "Timestamp",
      tool: "Product",
      model: "Model Name",
      title: "Conversation title",
      count: "Message count",
      tokens: "Total tokens",
      cost: "Cost (USD)",
    });
    expect(guessMapping(["email", "date", "messages"])).toEqual({ email: "email", at: "date", count: "messages" });
  });

  it("reads CSV and JSON, with nested JSON fields flattened", () => {
    const csv = readTable("usage.csv", 'email,date,title\nan@example.com,2026-10-20,"Tóm tắt, hợp đồng"\n');
    expect(csv).toMatchObject({ format: "csv", headers: ["email", "date", "title"] });
    expect(csv.records[0]!.title).toBe("Tóm tắt, hợp đồng");
    const json = readTable("export.json", JSON.stringify({ data: [{ user: { email: "an@example.com" }, created_at: "2026-10-20T08:00:00Z", tokens: 12 }] }));
    expect(json.headers).toEqual(["user.email", "created_at", "tokens"]);
    expect(guessMapping(json.headers)).toMatchObject({ at: "created_at", tokens: "tokens" });
  });

  it("keeps mapped fields only and parses numbers in either decimal style", () => {
    const rows = toImportRows(
      [
        { e: "an@example.com", d: "2026-10-20", n: "3", c: "$0,02", x: "secret column" },
        { e: "", d: "2026-10-20" },
        { e: "binh@example.com", d: "" },
      ],
      { email: "e", at: "d", count: "n", cost: "c" },
    );
    expect(rows).toEqual([{ email: "an@example.com", at: "2026-10-20", count: 3, cost: 0.02 }]);
    expect(parseNumber("1.234,5")).toBe(1234.5);
    expect(parseNumber("1,234.5")).toBe(1234.5);
    expect(parseNumber("abc")).toBeUndefined();
  });
});
