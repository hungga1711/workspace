import { describe, expect, it } from "vitest";
import { looksLikeQuestion } from "./questions.js";

describe("looksLikeQuestion", () => {
  it.each([
    "Is the report ready?",
    "can you send me the file",
    "Anh xem giúp em được không",
    "báo giá xong chưa",
    "Khi nào mình họp lại",
    "Nhờ anh duyệt hộ đơn này",
    "any update on T-041",
    "@Lan please check the invoice",
    "ai đang làm task này",
  ])("asks: %s", (s) => expect(looksLikeQuestion(s)).toBe(true));

  it.each(["Done, deployed.", "Cảm ơn anh", "AI tools are great", "> is this right?\nYes it is.", "see `what?` in the code", "https://example.com/?q=1", "", "ok"])(
    "does not ask: %s",
    (s) => expect(looksLikeQuestion(s)).toBe(false),
  );
});
