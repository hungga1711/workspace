import type { Metadata } from "next";
import { gw } from "@/lib/gateway";
import { getT } from "@/lib/i18n/server";
import { redirect } from "next/navigation";
import { aiStatus } from "@/lib/ai";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { WorkflowsView, type WorkflowTab } from "@/components/workflows/WorkflowsView";
import type { RunnerInfo, Workflow, WorkflowActivity, WorkflowTemplate } from "@/components/workflows/types";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("workflows.title") };
}

/** AI › Workflows: the library: the company's workflows, the runs and the template gallery as tabs (?tab=). */
const TABS: WorkflowTab[] = ["list", "runs", "performance", "templates"];

export default async function WorkflowsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab } = await searchParams;
  // The old Connect-a-computer tab: AI › Connect does it now.
  if (tab === "runner") redirect("/app/ai/connect");
  // Read apart: a failed activity read (figures, runs) shows LoadFailed in its own sections and the list stays.
  const [r, activity, ai] = await Promise.all([
    gw<{ workflows: Workflow[]; templates: WorkflowTemplate[]; runners?: RunnerInfo[] }>("/api/work/workflows").catch(() => null),
    gw<WorkflowActivity>("/api/work/workflows/activity").catch(() => null),
    aiStatus(),
  ]);
  if (!r) return <LoadFailed className="bg-surface shadow-card rounded-xl px-5 py-4" />;
  return (
    <WorkflowsView
      initial={r.workflows}
      templates={r.templates}
      activity={activity}
      runners={r.runners ?? []}
      aiOn={ai.configured}
      tab={TABS.includes(tab as WorkflowTab) ? (tab as WorkflowTab) : "list"}
    />
  );
}
