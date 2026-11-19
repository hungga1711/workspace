import type { Metadata } from "next";
import { gw } from "@/lib/gateway";
import { getT } from "@/lib/i18n/server";
import { aiStatus } from "@/lib/ai";
import { AdoptionView, type AdoptionData, type ProjectsData } from "@/components/ai-hub/AdoptionView";
import { AiScorecard, type AiPeopleData } from "@/components/ai-hub/AiScorecard";
import type { TokenUsageData } from "@/components/ai-hub/TokenUsage";
import type { Outcomes } from "@/components/work/AiEffect";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("aiHub.tabs.adoption") };
}

/**
 * AI › Áp dụng AI › Tổng quan: the scorecard first (what AI costs, whether it pays off, who uses it and how each
 * person does), then how AI works out per project and task, and the tasks that should use it. ?days= picks the period.
 */
export default async function AdoptionPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const sp = await searchParams;
  const days = ["7", "30", "90"].includes(sp.days ?? "") ? sp.days : "30";
  // Every read stands alone: a failed one shows that card's retry line, not a broken page. Only the token and outcome
  // reads depend on the people read (team or self), so the others start with it rather than after it.
  const dataP = gw<AdoptionData>(`/api/ai/adoption/suggestions?days=${days}`).catch(
    () =>
      ({
        days: Number(days),
        scope: "self",
        people: 0,
        mine: [],
        me: { assisted: 0, week: [], conversations: 0, tasks: 0, helpful: null, topics: [] },
      }) as AdoptionData,
  );
  const projectsP = gw<ProjectsData>(`/api/work/followup/ai-projects?days=${days}`).catch(() => null);
  const aiP = aiStatus();
  const people = await gw<AiPeopleData>(`/api/ai/adoption/people?days=${days}`).catch(() => null);
  const team = people?.scope === "team";
  const [data, projects, ai, tokens, outcomes] = await Promise.all([
    dataP,
    projectsP,
    aiP,
    gw<TokenUsageData>(`/api/ai/local-usage?days=${days}&scope=${team ? "team" : "me"}`).catch(() => null),
    // The same comparison Usage shows for these people and this period (work module).
    team ? gw<Outcomes>(`/api/work/followup/outcomes?days=${days}`).catch(() => null) : Promise.resolve(null),
  ]);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <AiScorecard people={people} tokens={tokens} outcomes={outcomes} base="/app/ai/adoption" />
      <AdoptionView data={data} projects={projects} assistant={ai.assistant} scored={!!people} />
    </div>
  );
}
