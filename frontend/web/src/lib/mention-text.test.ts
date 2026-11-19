import { describe, expect, it } from "vitest";
import { namesToTokens, tokensToNames } from "./mention-text";

describe("mention text", () => {
  const people = [
    { id: "u1", name: "Lan" },
    { id: "u2", name: "Lan Nguyễn" },
    { id: "u3", name: "Huy Trần" },
  ];
  it("round-trips tokens through names", () => {
    const body = "Nhờ <@u2> và <@u3> xem <@gone>";
    const text = tokensToNames(body, { u2: "Lan Nguyễn", u3: "Huy Trần" });
    expect(text).toBe("Nhờ @Lan Nguyễn và @Huy Trần xem <@gone>");
    expect(namesToTokens(text, people)).toBe(body);
  });
  it("prefers the longest name and stops at word boundaries", () => {
    expect(namesToTokens("@Lan Nguyễn, @Lan và @Lanh", people)).toBe("<@u2>, <@u1> và @Lanh");
  });
});
