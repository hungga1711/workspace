import { describe, expect, it } from "vitest";
import { deptTone, NO_TONE, personTone, toneIndex } from "./identity";

describe("identity colours", () => {
  it("gives a department the same colour however its name is typed", () => {
    expect(deptTone("Kỹ thuật")).toEqual(deptTone(" kỹ thuật "));
    // Decomposed (NFD) Vietnamese marks hash like the composed form.
    expect(deptTone("Kỹ thuật".normalize("NFD"))).toEqual(deptTone("Kỹ thuật"));
    // The department's channel slug wears the department's colour.
    expect(deptTone("ky-thuat")).toEqual(deptTone("Kỹ thuật"));
  });

  it("is neutral without a department", () => {
    expect(deptTone(null)).toBe(NO_TONE);
    expect(deptTone("  ")).toBe(NO_TONE);
  });

  it("stays within the eight hues and spreads the demo departments", () => {
    const names = ["Kỹ thuật", "Vận hành", "Kinh doanh", "Sản phẩm"];
    for (const n of names) expect(toneIndex(n)).toBeGreaterThanOrEqual(0);
    for (const n of names) expect(toneIndex(n)).toBeLessThan(8);
    expect(new Set(names.map(toneIndex)).size).toBe(names.length);
  });

  it("returns full class names Tailwind can see", () => {
    expect(personTone("01M4ZN2KGGA6ESB6Z0DQP4ZHX4").wash).toMatch(/^bg-art-\d-wash$/);
    expect(deptTone("Kỹ thuật").text).toMatch(/^text-art-\d-text$/);
  });
});
