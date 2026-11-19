import { notFound } from "next/navigation";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { gw } from "@/lib/gateway";
import { getT } from "@/lib/i18n/server";
import { AdminHeader } from "@/components/admin/AdminNav";
import { adminLoad, sectionGate } from "@/components/admin/guard";
import { AiSpendAdmin, type AiSpend, type SpendTargets } from "@/components/admin/AiSpendAdmin";
import { aiWorkspace } from "../flags";

/** Admin › AI › Cost & limits: what each model costs and the monthly budgets per company, department or person. */
export default async function AiCostAdminPage() {
  const gate = await sectionGate("/admin/workspace/ai");
  if (gate) return gate;
  const t = await getT();
  const r = await adminLoad(async () => {
    const f = await aiWorkspace();
    if (!f) return null;
    if (!f.assistant) notFound();
    const [spend, depts, people] = await Promise.all([
      gw<AiSpend>("/api/ai/spend").catch(() => null),
      gw<{ departments: SpendTargets["departments"] }>("/api/employee/departments").catch(() => ({ departments: [] })),
      gw<{ employees: SpendTargets["people"] }>("/api/employee/employees?all=1").catch(() => ({ employees: [] })),
    ]);
    return { spend, depts, people };
  });
  if ("denied" in r) return r.denied;
  return (
    <div className="grid grid-cols-1 gap-10">
      <AdminHeader title={t("aiAdmin.title")} sub={t("admin.aiTabs.costSub")} />
      {r.data?.spend ? (
        <AiSpendAdmin spend={r.data.spend} targets={{ departments: r.data.depts.departments, people: r.data.people.employees }} />
      ) : (
        <LoadFailed className="bg-surface shadow-card min-h-14 rounded-xl px-5 py-3.5" />
      )}
    </div>
  );
}
