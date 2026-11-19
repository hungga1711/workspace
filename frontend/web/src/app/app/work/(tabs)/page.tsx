import { redirect } from "next/navigation";
import { featureOn } from "@/lib/features";
import { RETIRED_PROGRESS_TABS, legacyWorkHref } from "@/components/work/workTabAlias";

/**
 * /app/work itself: Việc, and every old `?tab=` link (emails, chat messages, bookmarks) at its tab's own address
 * (/app/work/tasks, /app/work/calendar…), its other parameters kept.
 */
export default async function WorkIndex({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);
  const tab = one("tab");
  // Tiến độ › AI moved to its own destination (AI › Áp dụng AI › Mức sử dụng); old links and emails land there.
  if (tab === "ai") redirect(`/app/ai/adoption/usage${one("days") ? `?days=${encodeURIComponent(one("days")!)}` : ""}`);
  // Retired progress tabs: a person's line opens their page, the rest AI › Tiến độ (who needs attention, and why).
  if (tab && RETIRED_PROGRESS_TABS.includes(tab) && (one("u") || (await featureOn("ai"))))
    redirect(one("u") ? `/app/work/people/${encodeURIComponent(one("u")!)}` : "/app/ai/progress");
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) for (const x of Array.isArray(v) ? v : v === undefined ? [] : [v]) q.append(k, x);
  redirect(legacyWorkHref(q));
}
