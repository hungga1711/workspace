import { describe, expect, it } from "vitest";
import { formatMoney } from "./money";

describe("formatMoney", () => {
  it("shortens VND", () => {
    expect(formatMoney(165_000_000, "VND", "vi").short).toBe("165 tr");
    expect(formatMoney(2_100_000_000, "VND", "vi").short).toBe("2,1 tỷ");
    expect(formatMoney(850_000, "VND", "vi").short).toBe("850 ng");
    expect(formatMoney(5_000, "VND", "vi").short).toMatch(/5\.000/);
  });
  it("keeps cents for small USD", () => {
    expect(formatMoney(0.1627, "USD").short).toBe("$0.16");
    expect(formatMoney(0.1627, "USD").full).toBe("$0.1627");
    expect(formatMoney(1250, "EUR").short).toBe("€1,250");
    expect(formatMoney(50, "JPY").short).toBe("¥50");
    expect(formatMoney(12.5, "XXX").short).toMatch(/12\.50/);
  });
  it("uses M/B in English", () => {
    expect(formatMoney(2_100_000_000, "VND", "en").short).toBe("2.1 B");
  });
});
