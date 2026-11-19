/**
 * Which permissions each admin section needs (any one of them). `name@workspace` means held for the whole company
 * (a team-scoped grant cannot read the company timesheet). Shared by the page gates (guard.tsx) and the admin menu,
 * so a section is listed exactly when it opens. The modules still check every request.
 */
const PAGE_PERMS: Record<string, readonly string[]> = {
  "/admin/workspace/members": ["member.invite", "member.manage"],
  "/admin/workspace/roles": ["role.manage"],
  "/admin/workspace/teams": ["member.manage"],
  "/admin/workspace/attendance": ["attendance.read@workspace"],
  "/admin/workspace/leave": ["member.manage"],
  "/admin/workspace/leave/requests": ["leave.approve@workspace"],
  "/admin/workspace/holidays": ["member.manage"],
  "/admin/workspace/settings": ["workspace.configure"],
  "/admin/workspace/announcements": ["announcement.publish"],
  "/admin/workspace/custom-fields": ["workspace.configure"],
  "/admin/workspace/ai": ["ai.policy.manage", "ai.agent.manage"],
  "/admin/workspace/agents": ["ai.agent.manage"],
  "/admin/workspace/security": ["audit.read"],
  "/admin/workspace/integrations": ["workspace.configure"],
  "/admin/workspace/mcp": ["audit.read"],
  "/admin/workspace/audit": ["audit.read"],
  "/admin/workspace/errors": ["workspace.configure"],
};

/**
 * Admin sections of a feature a deployment can leave out (`DISABLED_FEATURES` on the server, ADR 0026), with their
 * sub-pages: not in the menu and not at their address without the feature.
 */
export const SECTION_FEATURE: Record<string, "time" | "ai"> = {
  "/admin/workspace/attendance": "time",
  "/admin/workspace/leave": "time",
  "/admin/workspace/ai": "ai",
  "/admin/workspace/agents": "ai",
};
export function sectionFeature(href: string): "time" | "ai" | undefined {
  return Object.entries(SECTION_FEATURE).find(([prefix]) => href === prefix || href.startsWith(`${prefix}/`))?.[1];
}

/** The viewer's permissions as tokens: "task.read" for any grant, plus "task.read@workspace" for a company-wide one. */
export function permTokens(r: { permissions: string[]; workspaceWide?: string[] }): string[] {
  return [...r.permissions, ...(r.workspaceWide ?? []).map((p) => `${p}@workspace`)];
}

/** Whether `perms` opens the section at `href` (a sub-path such as /attendance/<id> follows its section). Null = unknown: allow. */
export function canOpen(perms: ReadonlySet<string> | null, href: string): boolean {
  if (!perms) return true;
  const key = Object.keys(PAGE_PERMS)
    .filter((k) => href === k || href.startsWith(`${k}/`))
    .sort((a, b) => b.length - a.length)[0];
  return !key || PAGE_PERMS[key]!.some((p) => perms.has(p));
}
