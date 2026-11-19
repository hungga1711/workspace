/**
 * Which message groups each layout ships to its client components (I18nScope, getMessages). Server components read
 * every group; a client component can only show keys its area ships, and any other key renders as the raw key —
 * `areas.test.ts` follows each area's imports to keep that from happening.
 */
export const AREAS = {
  base: ["common", "format", "meta", "ui"],
  signIn: ["common", "format", "meta", "ui", "auth", "setup", "signIn", "demo"],
  meet: ["common", "format", "meta", "ui", "meet", "call"],
  app: { exclude: ["admin", "signIn", "setup"] },
  admin: { exclude: ["signIn", "setup"] },
} as const;
export type MessageArea = keyof typeof AREAS;

/** Personal API keys list permissions with Admin › Tích hợp's labels; attendance fixes show admin's status names. */
export const AREA_EXTRA: Partial<Record<MessageArea, readonly string[]>> = {
  app: ["admin.integrationsadmin", "admin.people.trang_thai"],
  // The OAuth consent page (MCP clients) sits among the sign-in screens.
  // …and so does the page an outside MCP server's sign-in returns to (/mcp-callback, workspace as the client).
  signIn: ["mcpServer.consent", "mcpClient.callback"],
};

/** The forced password change sits among the sign-in screens but shows the account form. */
export const CHANGE_PASSWORD_EXTRA = ["me.changepassword"] as const;

/** Whether a top-level group is shipped whole in an area. */
export function areaHasGroup(area: MessageArea, group: string): boolean {
  const spec = AREAS[area];
  return Array.isArray(spec) ? (spec as readonly string[]).includes(group) : !(spec as { exclude: readonly string[] }).exclude.includes(group);
}
