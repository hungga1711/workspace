import { gw } from "@/lib/gateway";
import { adminLoad, sectionGate } from "@/components/admin/guard";
import { RolesAdmin } from "@/components/admin/RolesAdmin";

export default async function RolesPage() {
  const gate = await sectionGate("/admin/workspace/roles");
  if (gate) return gate;
  const r = await adminLoad(() =>
    Promise.all([
      gw<{ roles: { id: string; name: string; system: boolean; grants: { permission: string; scope: string }[] }[] }>("/api/identity/roles"),
      gw<{ permissions: string[]; scopes: string[] }>("/api/identity/permissions"),
    ]),
  );
  if ("denied" in r) return r.denied;
  return <RolesAdmin roles={r.data[0].roles} catalog={r.data[1]} />;
}
