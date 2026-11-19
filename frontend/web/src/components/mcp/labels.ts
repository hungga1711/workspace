import type { T } from "@/lib/i18n/core";

/** One MCP tool call as identity's activity log returns it (no arguments or answers are kept). */
export interface McpCall {
  id: string;
  at: string;
  userId: string | null;
  userName: string | null;
  via: "oauth" | "personal_key" | "workspace_key" | "session";
  clientName: string | null;
  tool: string;
  ok: boolean;
  error: string | null;
  durationMs: number;
}

const TOOLS = [
  "list_my_tasks",
  "get_task",
  "create_task",
  "update_task",
  "comment_on_task",
  "list_projects",
  "get_project",
  "project_progress",
  "my_day",
  "list_documents",
  "read_document",
  "create_document",
  "list_whiteboards",
  "read_whiteboard",
  "list_channels",
  "read_channel",
  "read_thread",
  "post_message",
  "find_people",
  "search",
  "team_workload",
  "overdue_work",
  "blocked_work",
  "team_output",
  "unanswered_questions",
  "attendance_summary",
  "ai_insights_summary",
] as const;

/** A tool's name for people ("Tạo việc"); an unknown one (a newer server) shows as its id. */
export function toolLabel(t: T, tool: string): string {
  return (TOOLS as readonly string[]).includes(tool) ? t(`mcpServer.tools.${tool as (typeof TOOLS)[number]}`) : tool;
}

const PERMS = [
  "task.read",
  "project.read",
  "document.read",
  "message.read",
  "channel.read",
  "employee.profile.read",
  "home.read",
  "member.read",
  "file.read",
  "calendar.read",
  "task.create",
  "task.edit",
  "task.assign",
  "document.create",
  "document.edit",
  "message.post",
] as const;
type PermKey = (typeof PERMS)[number] extends infer P
  ? P extends string
    ? P extends `${infer A}.${infer B}.${infer C}`
      ? `${A}_${B}_${C}`
      : P extends `${infer A}.${infer B}`
        ? `${A}_${B}`
        : never
    : never
  : never;

/** The permission names an MCP connection uses, in people's words; others fall back to their id. */
export function permLabel(t: T, perm: string): string {
  return (PERMS as readonly string[]).includes(perm) ? t(`mcpServer.perm.${perm.replaceAll(".", "_") as PermKey}`) : perm;
}

const ERRORS = ["not_allowed", "not_found", "invalid", "invalid_arguments", "conflict", "unknown_tool", "failed", "internal"] as const;
/** The activity log's short failure reasons (identity mcp_calls.error). */
export const errorKey = (e: string): (typeof ERRORS)[number] => ((ERRORS as readonly string[]).includes(e) ? (e as (typeof ERRORS)[number]) : "failed");
