import { describe, expect, it } from "vitest";
import { csvCell, csvFile } from "./csv";

describe("csv", () => {
  it("quotes, doubles quotes and neutralises formulas", () => {
    expect(csvCell('Nói "xin chào"')).toBe('"Nói ""xin chào"""');
    expect(csvCell('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
    expect(csvCell(null)).toBe('""');
    expect(csvCell(3)).toBe('"3"');
  });
  it("starts with a BOM and uses CRLF", () => {
    expect(csvFile(["a"], [["b"]])).toBe('﻿"a"\r\n"b"\r\n');
  });
});
