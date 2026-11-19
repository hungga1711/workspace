import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { gw } from "@/lib/gateway";
import { getT } from "@/lib/i18n/server";
import { aiMonitoring, aiStatus } from "@/lib/ai";
import { progressAccess } from "@/lib/viewer";
import { IconTile } from "@/components/ui/Bento";
import { InfoIcon } from "@/components/app/icons";
import { AiOversightView, MyAi } from "@/components/work/tabs";
import type { AiOversight, Outcomes } from "@/components/work/AiOversightView";
import type { MyAiData } from "@/components/me/MyAi";
import { TokenUsage, type TokenUsageData } from "@/components/ai-hub/TokenUsage";
import { config } from "@/lib/config";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("aiHub.adoption.nav.usage") };
}

/**
 * Áp dụng AI › Mức sử dụng (was Tiến độ › AI): managers see their reporting line, admins everyone; anyone else sees
 * their own AI data, exactly as a manager sees it, never an access-denied page.
 */
export default async function AiUsagePage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  if (!(await aiMonitoring())) notFound();
  const sp = await searchParams;
  const tx = await getT();
  const days = ["7", "30", "90"].includes(sp.days ?? "") ? sp.days : "30";
  const mine = (await progressAccess()) === "self";
  const [data, outcomes, ai, tokens] = await Promise.all([
    mine ? Promise.resolve(null) : gw<AiOversight>(`/api/ai/oversight?days=${days}`).catch(() => null),
    // Work done next to AI use: does the AI the company pays for go with getting things done?
    mine ? Promise.resolve(null) : gw<Outcomes>(`/api/work/followup/outcomes?days=${days}`).catch(() => null),
    aiStatus(),
    // Every AI token, the coding agents on people's computers included (local-usage.ts); null hides the section.
    gw<TokenUsageData>(`/api/ai/local-usage?days=${days}&scope=${mine ? "me" : "team"}`).catch(() => null),
  ]);
  const tokenSection = tokens ? (
    <TokenUsage data={tokens} base="/app/ai/adoption/usage" origin={config.appUrl.replace(/\/$/, "")} apiUrl={config.appUrl.replace(/\/$/, "")} />
  ) : null;
  const myAi = data ? null : await gw<MyAiData>("/api/ai/oversight/me").catch(() => null);
  if (myAi)
    return (
      <div className="grid gap-5">
        {tokenSection}
        <MyAi data={myAi} />
      </div>
    );
  if (!data)
    return (
      <div className="bg-surface shadow-card flex items-start gap-3.5 rounded-xl p-5">
        <IconTile tone="sky">
          <InfoIcon />
        </IconTile>
        <div className="grid min-w-0 gap-1">
          <h2 className="m-0 text-sm font-semibold tracking-[-0.01em]">{tx("aiw.o.noAccessTitle")}</h2>
          <p className="text-ink-2 m-0 max-w-xl text-sm">{tx("aiw.o.noAccess")}</p>
        </div>
      </div>
    );
  return (
    <>
      {/* Extension tracking works without a company provider; say so when the assistant is off. */}
      {ai.assistant ? null : <p className="text-ink-2 m-0 mb-3 text-xs">{tx("aiOff.oversightNote")}</p>}
      {tokenSection ? <div className="mb-5">{tokenSection}</div> : null}
      <AiOversightView data={data} outcomes={outcomes} />
    </>
  );
}
