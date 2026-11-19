import type { T } from "@/lib/i18n/core";

/** Scope names, the same wherever grants are set (Roles, AI agents). */
export const SCOPE_LABEL = (tx: T): Record<string, string> => ({
  SELF: tx("admin.rolesadmin.cua_minh"),
  TEAM: tx("admin.rolesadmin.scope_team"),
  DEPARTMENT: tx("admin.rolesadmin.phong_ban"),
  WORKSPACE: tx("admin.rolesadmin.toan_cong_ty"),
  PLATFORM: tx("admin.rolesadmin.nen_tang"),
});
