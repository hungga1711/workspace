import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { gw } from "@/lib/gateway";
import { getT } from "@/lib/i18n/server";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { Blueprint } from "@/components/workflows/Blueprint";
import type { ModelCatalog, Prompting, RunnerInfo, Workflow, WorkflowActivity } from "@/components/workflows/types";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("workflows.title") };
}

/** One workflow read back: its harness (environment, resources, limits, output), then each step with what goes in and out (Blueprint). */
export default async function WorkflowPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Read apart: without the figures or the model list the pipeline still draws, it only says less.
  const [r, activity, catalog] = await Promise.all([
    gw<{ workflows: Workflow[]; prompting?: Prompting; runners?: RunnerInfo[] }>("/api/work/workflows").catch(() => null),
    gw<WorkflowActivity>("/api/work/workflows/activity").catch(() => null),
    gw<ModelCatalog>("/api/ai/workflows/models").catch(() => null),
  ]);
  if (!r) return <LoadFailed className="bg-surface shadow-card rounded-xl px-5 py-4" />;
  const w = r.workflows.find((x) => x.id === id);
  if (!w) notFound();
  return <Blueprint w={w} usage={activity ? (activity.usage[w.id] ?? null) : undefined} catalog={catalog} prompting={r.prompting ?? null} runners={r.runners ?? null} />;
}
