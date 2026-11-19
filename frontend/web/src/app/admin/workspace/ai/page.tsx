import { LoadFailed } from "@/components/ui/LoadFailed";
import { gw } from "@/lib/gateway";
import { getT } from "@/lib/i18n/server";
import { AdminHeader } from "@/components/admin/AdminNav";
import { adminLoad, sectionGate } from "@/components/admin/guard";
import { AiFeaturesAdmin } from "@/components/admin/AiFeaturesAdmin";
import { AiConnectionsAdmin, type AiConnection } from "@/components/admin/AiConnectionsAdmin";
import { McpServersAdmin, type McpData } from "@/components/admin/McpServersAdmin";
import type { SpendTargets } from "@/components/admin/AiSpendAdmin";
import { AiLocalAdmin, type LocalOverview, type LocalServer } from "@/components/admin/AiLocalAdmin";
import { aiWorkspace } from "./flags";

/**
 * Admin › AI › Connection: the two switches first (assistant, extension monitoring; both off until the company
 * decides), then, only once the assistant is on, how the company's own AI is connected (API key, LLM API or
 * self-hosted) and the outside tools it may use (MCP). Insights, privacy, cost and the danger zone are their own tabs.
 */
export default async function AiAdminPage() {
  const gate = await sectionGate("/admin/workspace/ai");
  if (gate) return gate;
  const r = await adminLoad(async () => {
    const f = await aiWorkspace();
    if (!f) return null;
    const [conn, depts, people, mcp] = f.assistant
      ? await Promise.all([
          gw<{ connections: AiConnection[]; env: string[] }>("/api/ai/connections").catch(() => null),
          gw<{ departments: SpendTargets["departments"] }>("/api/employee/departments").catch(() => ({ departments: [] })),
          gw<{ employees: SpendTargets["people"] }>("/api/employee/employees?all=1").catch(() => ({ employees: [] })),
          gw<McpData>("/api/ai/mcp/servers").catch(() => null),
        ])
      : [null, { departments: [] }, { employees: [] }, null];
    // AI that is already running: on this server (assistant only) and on connected computers (either switch).
    const [servers, local] =
      f.assistant || f.monitoring
        ? await Promise.all([
            f.assistant ? gw<{ servers: LocalServer[] }>("/api/ai/connections/discover").catch(() => null) : Promise.resolve(null),
            gw<LocalOverview>("/api/ai/local/connect/overview").catch(() => null),
          ])
        : [null, null];
    return { ...f, conn, depts, people, mcp, servers, local };
  });
  if ("denied" in r) return r.denied;
  if (!r.data) {
    const t = await getT();
    return (
      <div className="grid grid-cols-1">
        <AdminHeader title={t("aiAdmin.title")} sub={t("aiAdmin.sub")} />
        <LoadFailed className="bg-surface shadow-card min-h-14 rounded-xl px-5 py-3.5" />
      </div>
    );
  }
  const { ws, assistant, monitoring, conn, depts, people, mcp, servers, local } = r.data;
  return (
    <div className="grid grid-cols-1 gap-10">
      <AiFeaturesAdmin version={ws.configVersion} config={ws.config} flags={{ assistant, monitoring }} />
      {assistant || monitoring ? <AiLocalAdmin servers={servers?.servers ?? null} overview={local} assistant={assistant} /> : null}
      {/* A section whose read failed shows a retry in its place: hiding it would read as "not set up". */}
      {assistant ? conn ? <AiConnectionsAdmin connections={conn.connections} env={conn.env} noHeader /> : <LoadFailed /> : null}
      {assistant ? (
        mcp ? (
          <McpServersAdmin
            data={mcp}
            aiReady={!!conn && (conn.connections.some((c) => c.enabled) || conn.env.length > 0)}
            departments={depts.departments}
            people={people.employees}
          />
        ) : (
          <LoadFailed />
        )
      ) : null}
    </div>
  );
}
