import type { Grant, Scope } from "@workspace/shared";

/** Every permission the platform knows. Roles may only grant these. */
export const PERMISSIONS = [
  "workspace.read",
  "workspace.configure",
  "member.read",
  "member.invite",
  "member.manage",
  "role.manage",
  "audit.read",
  "channel.create",
  "channel.read",
  "channel.manage",
  "message.post",
  "message.read",
  "message.delete_any",
  "project.read",
  "project.create",
  "project.edit",
  "project.delete",
  "task.read",
  "task.create",
  "task.edit",
  "task.assign",
  "task.delete",
  "document.read",
  "document.create",
  "document.edit",
  "document.share",
  "file.upload",
  "file.read",
  "calendar.read",
  "calendar.edit",
  "approval.decide",
  "employee.profile.read",
  "employee.profile.edit",
  "employee.salary.read",
  "attendance.read",
  "attendance.record",
  "leave.request",
  "leave.approve",
  "ai.use",
  "ai.agent.manage",
  "ai.policy.manage",
  "ai.prompt.manage",
  "agent.invoke",
  "notification.create",
  "home.read",
  "announcement.publish",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const all = (scope: Scope, except: Permission[] = []): Grant[] => PERMISSIONS.filter((p) => !except.includes(p)).map((permission) => ({ permission, scope }));

const g = (scope: Scope, ...perms: Permission[]): Grant[] => perms.map((permission) => ({ permission, scope }));

const EMPLOYEE: Grant[] = [
  ...g(
    "WORKSPACE",
    "workspace.read",
    "member.read",
    "channel.create",
    "channel.read",
    "message.post",
    "message.read",
    "project.read",
    "project.create",
    "task.read",
    "task.create",
    "document.read",
    "document.create",
    "file.upload",
    "file.read",
    "employee.profile.read",
    "ai.use",
    "agent.invoke",
    "notification.create",
  ),
  ...g(
    "SELF",
    "task.edit",
    "task.assign",
    "document.edit",
    "document.share",
    "calendar.read",
    "calendar.edit",
    "employee.profile.edit",
    "attendance.read",
    "attendance.record",
    "leave.request",
    "home.read",
  ),
];

const MANAGER: Grant[] = [
  ...g("TEAM", "task.edit", "task.assign", "task.delete", "project.edit", "approval.decide", "leave.approve", "attendance.read", "calendar.read"),
  // Company prompts for their own department (AI › Thư viện prompt).
  ...g("DEPARTMENT", "ai.prompt.manage"),
];

export interface DefaultRole {
  name: string;
  grants: Grant[];
}

/** Seeded at first-run setup. Admins can add roles; system roles cannot be deleted. */
export const DEFAULT_ROLES: DefaultRole[] = [
  { name: "Owner", grants: all("WORKSPACE") },
  { name: "Admin", grants: all("WORKSPACE") },
  { name: "Manager", grants: MANAGER },
  { name: "Employee", grants: EMPLOYEE },
];

/** Default agent templates. Each has grants (what data) and tools (what it may do). */
export const DEFAULT_AGENTS = [
  {
    name: "Project Agent",
    description: "Project status and late tasks; creates tasks when asked.",
    grants: g("WORKSPACE", "project.read", "task.read", "task.create", "task.edit", "notification.create", "message.read", "document.read"),
    tools: ["project_status", "list_my_tasks", "search_messages", "get_thread", "create_task"],
  },
  {
    name: "Research Agent",
    description: "Finds and summarises information from documents and conversations.",
    grants: g("WORKSPACE", "document.read", "message.read", "project.read"),
    tools: ["search_documents", "get_document", "search_messages", "get_thread"],
  },
  {
    name: "Meeting Agent",
    description: "Summarises discussions and pulls out tasks and decisions after meetings.",
    grants: g("WORKSPACE", "message.read", "task.read", "task.create", "document.read"),
    tools: ["get_thread", "search_messages", "create_task", "search_documents", "get_document"],
  },
  {
    name: "Documentation Agent",
    description: "Answers questions from internal documents and compares documents.",
    grants: g("WORKSPACE", "document.read", "project.read"),
    tools: ["search_documents", "get_document"],
  },
];

/**
 * Combines grants from several roles. Scopes are not nested (TEAM does not cover a SELF-owned task outside the
 * team), so every distinct (permission, scope) pair is kept instead of collapsing to the widest.
 */
export function mergeGrants(grants: Grant[]): Grant[] {
  const seen = new Map<string, Grant>();
  for (const gr of grants) seen.set(`${gr.permission}|${gr.scope}`, gr);
  return [...seen.values()].sort((a, b) => (a.permission + a.scope).localeCompare(b.permission + b.scope));
}
