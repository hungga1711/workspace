import { describe, expect, it } from "vitest";
import { descriptionTemplate, withTemplate } from "./task-write";
import type { T } from "@/lib/i18n/core";

const tx = ((k: string) =>
  ({ "work.taskwrite.tplGoal": "Mục tiêu", "work.taskwrite.tplTodo": "Việc cần làm", "work.taskwrite.tplDone": "Tiêu chí hoàn thành", "work.taskwrite.tplNotes": "Ghi chú" })[k] ??
  k) as T;

describe("description template", () => {
  it("has the sections with empty checklists", () => {
    const t = descriptionTemplate(tx);
    expect(t.startsWith("## Mục tiêu\n")).toBe(true);
    expect(t).toContain("## Việc cần làm\n- [ ] ");
    expect(t).toContain("## Tiêu chí hoàn thành\n- [ ] ");
  });
  it("goes after existing text, once", () => {
    const t = descriptionTemplate(tx);
    expect(withTemplate("", t)).toBe(t);
    expect(withTemplate("Bối cảnh\n\n", t)).toBe(`Bối cảnh\n\n${t}`);
    const once = withTemplate("Bối cảnh", t);
    expect(withTemplate(once, t)).toBe(once);
  });
});
