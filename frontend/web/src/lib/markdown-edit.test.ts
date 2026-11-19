import { describe, expect, it } from "vitest";
import { applyMarkdown, continueList, toggleTask } from "./markdown-edit";

describe("applyMarkdown", () => {
  it("wraps the selection and keeps it selected", () => {
    expect(applyMarkdown("make this bold", 5, 9, "**")).toEqual({ text: "make **this** bold", from: 7, to: 11 });
  });
  it("prefixes every selected line, numbering ordered lists", () => {
    expect(applyMarkdown("a\nb\nc", 0, 5, "1. ", "", true).text).toBe("1. a\n2. b\n3. c");
    expect(applyMarkdown("x\ntodo", 3, 3, "- [ ] ", "", true).text).toBe("x\n- [ ] todo");
  });
});

describe("continueList", () => {
  it("continues bullets, numbers and checklists, and ends the list on an empty item", () => {
    expect(continueList("- a", 3)?.text).toBe("- a\n- ");
    expect(continueList("2. b", 4)?.text).toBe("2. b\n3. ");
    expect(continueList("- [x] done", 10)?.text).toBe("- [x] done\n- [ ] ");
    expect(continueList("- a\n- ", 6)).toEqual({ text: "- a\n", from: 4, to: 4 });
    expect(continueList("plain", 5)).toBeNull();
  });
});

describe("toggleTask", () => {
  it("flips the n-th checklist item and skips code blocks", () => {
    const text = "- [ ] a\n```\n- [ ] code\n```\n- [x] b";
    expect(toggleTask(text, 0)).toBe("- [x] a\n```\n- [ ] code\n```\n- [x] b");
    expect(toggleTask(text, 1)).toBe("- [ ] a\n```\n- [ ] code\n```\n- [ ] b");
  });
});
