import { gw, GatewayError } from "@/lib/gateway";
import { getT } from "@/lib/i18n/server";
import { sectionGate } from "@/components/admin/guard";
import { AdminHeader } from "@/components/admin/AdminNav";
import { McpAdmin, type McpActivity, type McpConnections } from "@/components/admin/McpAdmin";

const DAYS = ["1", "7", "30", "90"] as const;

/**
 * Quản trị › Bảo mật & tích hợp › AI agent: every AI app connected over MCP (OAuth and personal keys) and the log of
 * the tools they called. Each half loads on its own, so one failed read shows a retry, never an error page.
 */
export default async function McpAdminPage({ searchParams }: { searchParams: Promise<{ days?: string; tool?: string }> }) {
  const gate = await sectionGate("/admin/workspace/mcp");
  if (gate) return gate;
  const tx = await getT();
  const sp = await searchParams;
  const days = (DAYS as readonly string[]).includes(sp.days ?? "") ? sp.days! : "7";
  const tool = sp.tool && /^[a-z_]{1,60}$/.test(sp.tool) ? sp.tool : null;
  const failed = (e: unknown) => {
    if (e instanceof GatewayError && e.status === 403) return "denied" as const;
    return null;
  };
  const [connections, activity] = await Promise.all([
    gw<McpConnections>("/api/identity/oauth/grants").catch(failed),
    gw<McpActivity>(`/api/identity/mcp/activity?days=${days}${tool ? `&tool=${tool}` : ""}`).catch(failed),
  ]);
  return (
    <>
      <AdminHeader title={tx("mcpServer.admin.nav")} sub={tx("mcpServer.admin.desc")} />
      <McpAdmin connections={connections} activity={activity} days={days} tool={tool} />
    </>
  );
}
