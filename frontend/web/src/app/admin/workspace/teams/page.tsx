import { gw } from "@/lib/gateway";
import { adminLoad, sectionGate } from "@/components/admin/guard";
import { TeamsAdmin } from "@/components/admin/TeamsAdmin";

export default async function TeamsPage() {
  const gate = await sectionGate("/admin/workspace/teams");
  if (gate) return gate;
  const r = await adminLoad(() =>
    Promise.all([
      gw<{ teams: { id: string; name: string; memberIds: string[] }[] }>("/api/identity/teams"),
      // Departments live in another module; a failed read shows a retry in their section, not an error page.
      gw<{ departments: { id: string; name: string; headId: string | null; members: number }[] }>("/api/employee/departments").catch(() => null),
    ]),
  );
  if ("denied" in r) return r.denied;
  return <TeamsAdmin teams={r.data[0].teams} departments={r.data[1]?.departments ?? null} />;
}
