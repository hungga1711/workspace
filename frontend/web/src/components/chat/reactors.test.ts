import { describe, expect, it } from "vitest";
import { makeT } from "@/lib/i18n/dicts";
import { reactorsText } from "./reactors";

const t = makeT("vi");
const names: Record<string, string> = { lan: "Lan", huy: "Huy", an: "An", minh: "Minh" };
const name = (id: string) => names[id] ?? id;

describe("reactorsText", () => {
  it("puts the viewer first as Bạn and counts the rest", () => {
    expect(reactorsText(t, ["lan", "me"], 2, "me", name)).toBe("Bạn và Lan");
    expect(reactorsText(t, ["lan", "huy", "me"], 3, "me", name)).toBe("Bạn, Lan và Huy");
    expect(reactorsText(t, ["lan", "huy", "an", "minh", "me"], 5, "me", name)).toBe("Bạn, Lan, Huy và 2 người khác");
    expect(reactorsText(t, ["lan"], 1, "me", name)).toBe("Lan");
    // More reactions than the 20 names the API sends.
    expect(reactorsText(t, ["lan", "huy", "an"], 25, "me", name)).toBe("Lan, Huy, An và 22 người khác");
    expect(reactorsText(t, [], 4, "me", name)).toBe("4 người");
  });
});
