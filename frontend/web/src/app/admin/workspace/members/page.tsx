import { gw } from "@/lib/gateway";
import { adminLoad, sectionGate } from "@/components/admin/guard";
import { MembersAdmin } from "@/components/admin/MembersAdmin";

export default async function MembersPage() {
  const gate = await sectionGate("/admin/workspace/members");
  if (gate) return gate;
  const r = await adminLoad(() =>
    Promise.all([
      gw<{ members: { userId: string; email: string; displayName: string; status: string; roles: string[]; isOwner: boolean }[]; counts: { active: number } }>(
        "/api/identity/members",
      ),
      // The roles only feed the invite and role pickers; the member list stands without them.
      gw<{ roles: { id: string; name: string; system: boolean }[] }>("/api/identity/roles").catch(() => null),
      gw<{ employees: { userId: string; title: string; department: string | null; managerId: string | null }[] }>("/api/employee/employees?all=1").catch(() => ({ employees: [] })),
      gw<{ departments: { id: string; name: string }[] }>("/api/employee/departments").catch(() => ({ departments: [] })),
    ]),
  );
  if ("denied" in r) return r.denied;
  const [m, roles, emps, depts] = r.data;
  return <MembersAdmin members={m.members} roles={roles?.roles ?? null} employees={emps.employees} departments={depts.departments} />;
}
