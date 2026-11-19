import { gw } from "@/lib/gateway";
import { adminLoad, sectionGate } from "@/components/admin/guard";
import { CustomFieldsAdmin } from "@/components/admin/CustomFieldsAdmin";
import type { FieldDef } from "@/components/work/types";

export default async function CustomFieldsPage() {
  const gate = await sectionGate("/admin/workspace/custom-fields");
  if (gate) return gate;
  const r = await adminLoad(() => gw<{ fields: FieldDef[] }>("/api/work/custom-fields"));
  if ("denied" in r) return r.denied;
  return <CustomFieldsAdmin fields={r.data.fields} />;
}
