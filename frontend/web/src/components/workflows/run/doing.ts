"use client";

import { useT } from "@/lib/i18n/client";
import type { StepActivity } from "../types";

/**
 * What a coding agent's tools are called, as what they do: the pipeline reads "Reads src/app.ts", not "Read". A tool
 * not listed here (a company tool, another agent's) shows under its own name.
 */
export type ToolVerb = "read" | "write" | "edit" | "run" | "search" | "open" | "web" | "helper" | "plan";
export const TOOL_VERBS: Record<string, ToolVerb> = {
  Read: "read",
  NotebookRead: "read",
  Write: "write",
  Edit: "edit",
  MultiEdit: "edit",
  NotebookEdit: "edit",
  Bash: "run",
  Grep: "search",
  Glob: "search",
  WebFetch: "open",
  WebSearch: "web",
  Task: "helper",
  Agent: "helper",
  TodoWrite: "plan",
};

/** An action's name in words: what it does, or the tool's own name. */
export function useToolName() {
  const t = useT();
  return (tool: string | null) => {
    const verb = tool ? TOOL_VERBS[tool] : undefined;
    if (verb) return t(`workflows.activity.tool.${verb}`);
    // A connected tool as a coding agent names it (mcp__server__tool) reads like the company's own: "server › tool".
    const mcp = /^mcp__(.+?)__(.+)$/.exec(tool ?? "");
    return mcp ? `${mcp[1]} › ${mcp[2]}` : tool || t("workflows.activity.tool.other");
  };
}

/**
 * What a step is doing right now, as one line: for the task's card and anywhere a whole feed does not fit. Kept apart
 * from the feed (StepActivity.tsx) so the card does not load it.
 */
export function useDoingLine() {
  const t = useT();
  const name = useToolName();
  return (e: Pick<StepActivity, "kind" | "tool" | "text"> | undefined) => {
    if (!e) return "";
    if (e.kind === "draft") return t("workflows.activity.writing");
    if (e.kind === "tool") return [name(e.tool), e.text].filter(Boolean).join(" ");
    return e.text.split("\n")[0] ?? "";
  };
}
