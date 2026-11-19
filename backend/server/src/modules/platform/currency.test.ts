import { describe, expect, it } from "vitest";
import { currencyFor } from "./currency.js";

describe("currencyFor", () => {
  it("follows the workspace's time zone, then its language", () => {
    expect(currencyFor("Europe/London", "en")).toBe("GBP");
    expect(currencyFor("Asia/Ho_Chi_Minh", "vi")).toBe("VND");
    expect(currencyFor("Europe/Paris", "en")).toBe("EUR");
    expect(currencyFor("Africa/Nairobi", "vi")).toBe("VND");
    expect(currencyFor("Africa/Nairobi", "en")).toBe("USD");
  });
});
