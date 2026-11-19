import type { T } from "@/lib/i18n/core";

/**
 * "AI viết giúp" on a task, the parts that need no model: the description template (Mẫu mô tả, for everyone, AI or
 * not) and how a proposal is merged. The AI side is components/work/TaskWritePanel.tsx; the API is
 * POST /api/ai/tasks/write (docs/architecture/task-ai-write.md).
 */

export const WRITE_MODES = ["draft", "improve", "shorter", "longer", "criteria", "checklist", "custom"] as const;
export type WriteMode = (typeof WRITE_MODES)[number];

/** What the AI proposes: a title only when it changed it. */
export interface WriteProposal {
  title?: string;
  description: string;
  language: "vi" | "en";
  truncated: boolean;
  /** Dates, numbers, links or people the proposal states that the text did not. */
  added: string[];
}

/** The structured skeleton: the same sections the AI draft uses, as Markdown with empty checklists. */
export function descriptionTemplate(tx: T): string {
  return [
    `## ${tx("work.taskwrite.tplGoal")}`,
    "",
    `## ${tx("work.taskwrite.tplTodo")}`,
    "- [ ] ",
    "",
    `## ${tx("work.taskwrite.tplDone")}`,
    "- [ ] ",
    "",
    `## ${tx("work.taskwrite.tplNotes")}`,
    "",
  ].join("\n");
}

/** The template goes after what is written (never replacing it); twice in a row adds nothing. */
export function withTemplate(description: string, template: string): string {
  const cur = description.trimEnd();
  if (!cur) return template;
  if (cur.includes(template.split("\n")[0]!)) return description;
  return `${cur}\n\n${template}`;
}
