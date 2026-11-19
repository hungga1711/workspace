import { notFound } from "next/navigation";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { gw } from "@/lib/gateway";
import { getT } from "@/lib/i18n/server";
import { AdminHeader } from "@/components/admin/AdminNav";
import { adminLoad, sectionGate } from "@/components/admin/guard";
import { AiSafetyAdmin, type AiKeyword, type AiSafetyPolicy } from "@/components/admin/AiSafetyAdmin";
import { AiReadPolicyAdmin } from "@/components/admin/AiReadPolicyAdmin";
import { AiErasureAdmin, type ErasureRequest } from "@/components/admin/AiErasureAdmin";
import { aiWorkspace } from "../flags";

/**
 * Admin › AI › Privacy: what managers can read and for how long, the safety net for sensitive data in prompts, and
 * people's requests to delete their AI data. Everything here is also explained to staff on Hồ sơ › Quyền riêng tư & AI.
 */
export default async function AiPrivacyAdminPage() {
  const gate = await sectionGate("/admin/workspace/ai");
  if (gate) return gate;
  const t = await getT();
  const r = await adminLoad(async () => {
    const f = await aiWorkspace();
    if (!f) return null;
    if (!f.monitoring) notFound();
    const [policy, keywords, erasure] = await Promise.all([
      gw<{ policy: AiSafetyPolicy }>("/api/ai/policy").catch(() => null),
      gw<{ keywords: AiKeyword[] }>("/api/ai/policy/keywords").catch(() => ({ keywords: [] })),
      gw<{ requests: ErasureRequest[] }>("/api/ai/oversight/erasure-requests").catch(() => null),
    ]);
    return { policy, keywords, erasure };
  });
  if ("denied" in r) return r.denied;
  return (
    <div className="grid grid-cols-1 gap-10">
      <AdminHeader title={t("aiAdmin.title")} sub={t("admin.aiTabs.privacySub")} />
      {!r.data ? (
        <LoadFailed className="bg-surface shadow-card min-h-14 rounded-xl px-5 py-3.5" />
      ) : (
        <>
          {r.data.policy ? <AiReadPolicyAdmin policy={r.data.policy.policy} /> : <LoadFailed />}
          {r.data.policy ? <AiSafetyAdmin policy={r.data.policy.policy} keywords={r.data.keywords.keywords} /> : null}
          {r.data.erasure ? <AiErasureAdmin requests={r.data.erasure.requests} /> : <LoadFailed />}
        </>
      )}
    </div>
  );
}
