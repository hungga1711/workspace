import { gw, GatewayError } from "@/lib/gateway";
import { getT } from "@/lib/i18n/server";
import { adminLoad, sectionGate } from "@/components/admin/guard";
import { AdminHeader } from "@/components/admin/AdminNav";
import { AuditView } from "@/components/admin/AuditView";
import type { ActorNames } from "@/components/admin/AuditRows";
import { TRAIL_PAGE, filterFromParams, filterParams, trailQuery, type TrailPage, type TrailStats } from "@/components/admin/audit";

/** Admin › Nhật ký: the audit trail of the whole workspace (ADR 0025), filtered by the URL. */
export default async function AuditPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const gate = await sectionGate("/admin/workspace/audit");
  if (gate) return gate;
  const tx = await getT();
  const filter = filterFromParams(await searchParams);
  const q = trailQuery(filter);
  const list = new URLSearchParams(q);
  list.set("limit", String(TRAIL_PAGE));
  // The list decides access (403 → the "not allowed" screen); the totals and the actor names fail on their own.
  const r = await adminLoad(async () => {
    const [page, stats, agents, keys] = await Promise.all([
      gw<TrailPage>(`/api/platform/audit?${list}`).catch((e: unknown) => {
        if (e instanceof GatewayError && e.status === 403) throw e;
        return null;
      }),
      gw<TrailStats>(`/api/platform/audit/stats?${q}`).catch(() => null),
      gw<{ agents: { id: string; name: string }[] }>("/api/identity/agents").catch(() => ({ agents: [] })),
      gw<{ keys: { id: string; name: string }[] }>("/api/identity/api-keys").catch(() => ({ keys: [] })),
    ]);
    return { page, stats, agents, keys };
  });
  if ("denied" in r) return r.denied;
  const names: ActorNames = Object.fromEntries([...r.data.agents.agents.map((a) => [`agent:${a.id}`, a.name]), ...r.data.keys.keys.map((k) => [`apikey:${k.id}`, k.name])]);
  return (
    <>
      <AdminHeader title={tx("admin.trail.title")} sub={tx("admin.trail.sub")} />
      <AuditView key={filterParams(filter).toString()} filter={filter} page={r.data.page} stats={r.data.stats} names={names} />
    </>
  );
}
