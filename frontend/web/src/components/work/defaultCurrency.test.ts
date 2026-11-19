import { describe, expect, it } from "vitest";
import { defaultCurrency } from "./defaultCurrency";

describe("defaultCurrency", () => {
  it("keeps the admin's choice", () => expect(defaultCurrency("EUR", "Europe/London", "en")).toBe("EUR"));
  it("follows the workspace zone when none is set", () => {
    expect(defaultCurrency(null, "Europe/London", "en")).toBe("GBP");
    expect(defaultCurrency(undefined, "Asia/Ho_Chi_Minh", "en")).toBe("VND");
    expect(defaultCurrency(null, "Europe/Berlin", "en")).toBe("EUR");
    expect(defaultCurrency(null, "America/New_York", "en")).toBe("USD");
  });
  it("falls back by language for other zones", () => {
    expect(defaultCurrency(null, "Africa/Lagos", "vi")).toBe("VND");
    expect(defaultCurrency(null, "Africa/Lagos", "en")).toBe("USD");
  });
});
