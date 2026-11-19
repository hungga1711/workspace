import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { gw } from "@/lib/gateway";
import { getT } from "@/lib/i18n/server";
import { aiStatus } from "@/lib/ai";
import { PromptLibrary, type Department, type LibraryList, type LibraryTab } from "@/components/ai-insights/PromptLibrary";
import type { TopicRow } from "@/components/ai-insights/SharePromptDialog";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("aiInsights.library.title") };
}

const TABS: LibraryTab[] = ["company", "mine", "team", "review"];

/**
 * Thư viện prompt: the company's prompts and each person's own, open to everyone while AI Insights is on (the gateway
 * 404s it otherwise). ?tab= picks the tab. A failed read still opens the page with a retry.
 */
export default async function PromptLibraryPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const status = await aiStatus();
  if (!status.monitoring) notFound();
  const t = await getT();
  const { tab: tabQ } = await searchParams;
  const tab = TABS.includes(tabQ as LibraryTab) ? (tabQ as LibraryTab) : "company";
  const [lib, topics, depts] = await Promise.all([
    gw<LibraryList>(`/api/ai/insights/library?tab=${tab}`).catch(() => null),
    gw<{ topics: TopicRow[] }>("/api/ai/insights/topics").catch(() => ({ topics: [] as TopicRow[] })),
    gw<{ departments: Department[] }>("/api/employee/departments").catch(() => ({ departments: [] as Department[] })),
  ]);
  return (
    <div className="grid gap-4">
      <p className="text-ink-2 m-0 text-sm">{t("aiInsights.library.sub")}</p>
      <PromptLibrary initial={lib} initialTab={tab} topics={topics.topics} departments={depts.departments.map((d) => ({ id: d.id, name: d.name }))} assistant={status.assistant} />
    </div>
  );
}
