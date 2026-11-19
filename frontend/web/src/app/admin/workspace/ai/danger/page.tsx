import { getT } from "@/lib/i18n/server";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { AdminHeader } from "@/components/admin/AdminNav";
import { adminLoad, sectionGate } from "@/components/admin/guard";
import { AiDangerAdmin } from "@/components/admin/AiDangerAdmin";
import { aiWorkspace } from "../flags";

/** Admin › AI › Danger zone: actions that cannot be undone, away from the everyday switches. */
export default async function AiDangerAdminPage() {
  const gate = await sectionGate("/admin/workspace/ai");
  if (gate) return gate;
  const t = await getT();
  const r = await adminLoad(() => aiWorkspace());
  if ("denied" in r) return r.denied;
  const company = r.data?.ws.config.branding?.displayName || r.data?.ws.workspace?.name || "";
  return (
    <div className="grid grid-cols-1 gap-6">
      <AdminHeader title={t("aiAdmin.title")} sub={t("admin.aiTabs.dangerSub")} />
      {r.data ? <AiDangerAdmin company={company} /> : <LoadFailed className="bg-surface shadow-card min-h-14 rounded-xl px-5 py-3.5" />}
    </div>
  );
}
