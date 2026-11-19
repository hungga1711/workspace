import Link from "next/link";
import { gw } from "@/lib/gateway";
import { btnPrimary, cx } from "@/lib/ui";
import { adminLoad, sectionGate } from "@/components/admin/guard";
import { AgentsAdmin } from "@/components/admin/AgentsAdmin";
import { aiStatus } from "@/lib/ai";
import { getT } from "@/lib/i18n/server";

export default async function AgentsPage() {
  const gate = await sectionGate("/admin/workspace/agents");
  if (gate) return gate;
  // Admin › AI: without a provider the assistant and agents cannot run; say how to connect one instead.
  const ai = await aiStatus();
  if (!ai.assistant) {
    const t = await getT();
    return (
      <div className="bg-surface shadow-card grid max-w-2xl gap-2 rounded-xl p-6">
        <h1 className="font-display m-0 text-xl font-semibold">{t(ai.assistantWanted ? "aiOff.title" : "aiOff.disabledTitle")}</h1>
        <p className="text-ink-2 m-0 text-sm">{t(ai.assistantWanted ? "aiOff.agentsBody" : "aiOff.disabledBody")}</p>
        <Link href="/admin/workspace/ai" className={cx(btnPrimary, "mt-2 justify-self-start no-underline")}>
          {t("aiOff.adminCta")}
        </Link>
      </div>
    );
  }
  const r = await adminLoad(() =>
    Promise.all([
      gw<{ agents: { id: string; name: string; status: string; budget: number; grants: { permission: string; scope: string }[] }[] }>("/api/identity/agents"),
      gw<{ permissions: string[]; scopes: string[] }>("/api/identity/permissions"),
      gw<{
        deniedToolCalls: { tool: string; actorId: string; agentId: string | null; reason: string; at: string }[];
        byAgent: { agentId: string; tokens: number; calls: number }[];
      }>("/api/ai/usage").catch(() => null),
    ]),
  );
  if ("denied" in r) return r.denied;
  return <AgentsAdmin agents={r.data[0].agents} catalog={r.data[1]} denied={r.data[2]?.deniedToolCalls ?? null} usage={r.data[2]?.byAgent ?? []} />;
}
