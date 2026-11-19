import { notFound } from "next/navigation";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { gw } from "@/lib/gateway";
import { getT } from "@/lib/i18n/server";
import { AdminHeader } from "@/components/admin/AdminNav";
import { adminLoad, sectionGate } from "@/components/admin/guard";
import { AiTopicsAdmin, type AiTopic } from "@/components/admin/AiTopicsAdmin";
import { AiReportEmailAdmin, type ReportSettings } from "@/components/admin/AiReportEmailAdmin";
import type { AiImportLog } from "@/components/admin/AiImportAdmin";
import { AiImportAdmin } from "@/components/admin/AiImportAdminLazy";
import { aiWorkspace } from "../flags";

/** Admin › AI › Insights: how AI Insights groups and reports what the extension records (topics, weekly email, imports). */
export default async function AiInsightsAdminPage() {
  const gate = await sectionGate("/admin/workspace/ai");
  if (gate) return gate;
  const t = await getT();
  const r = await adminLoad(async () => {
    const f = await aiWorkspace();
    if (!f) return null;
    if (!f.monitoring) notFound();
    const [topics, imports, report] = await Promise.all([
      gw<{ topics: AiTopic[] }>("/api/ai/insights/topics").catch(() => null),
      gw<{ imports: AiImportLog[] }>("/api/ai/insights/imports").catch(() => ({ imports: [] })),
      gw<ReportSettings>("/api/ai/insights/report/settings").catch(() => null),
    ]);
    return { topics, imports, report };
  });
  if ("denied" in r) return r.denied;
  return (
    <div className="grid grid-cols-1 gap-10">
      <AdminHeader title={t("aiAdmin.title")} sub={t("admin.aiTabs.insightsSub")} />
      {!r.data ? (
        <LoadFailed className="bg-surface shadow-card min-h-14 rounded-xl px-5 py-3.5" />
      ) : (
        <>
          {r.data.topics ? <AiTopicsAdmin topics={r.data.topics.topics} /> : <LoadFailed />}
          {r.data.report ? <AiReportEmailAdmin settings={r.data.report} /> : <LoadFailed />}
          <AiImportAdmin history={r.data.imports.imports} />
        </>
      )}
    </div>
  );
}
