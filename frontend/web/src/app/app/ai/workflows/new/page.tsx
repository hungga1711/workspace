import type { Metadata } from "next";
import { gw } from "@/lib/gateway";
import { getT } from "@/lib/i18n/server";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { Studio } from "@/components/workflows/studio/Studio";
import { blankDraft, copyOf, draftFromTemplate } from "@/components/workflows/studio/draft";
import type { ModelCatalog, Prompting, RunnerInfo, Workflow, WorkflowTemplate } from "@/components/workflows/types";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("workflows.editor.newTitle") };
}

/**
 * A new workflow in the studio: blank, from a template (?template=<key>) or as a copy of a workflow (?from=<id>).
 * An unknown template or workflow starts blank rather than failing.
 */
export default async function NewWorkflowPage({ searchParams }: { searchParams: Promise<{ template?: string; from?: string }> }) {
  const { template, from } = await searchParams;
  const t = await getT();
  // Read apart: without the model list the studio still opens (steps keep the company's default).
  const [r, catalog] = await Promise.all([
    gw<{ workflows: Workflow[]; templates: WorkflowTemplate[]; prompting?: Prompting; runners?: RunnerInfo[] }>("/api/work/workflows").catch(() => null),
    gw<ModelCatalog>("/api/ai/workflows/models").catch(() => null),
  ]);
  if (!r) return <LoadFailed className="bg-surface shadow-card rounded-xl px-5 py-4" />;
  const tp = template ? r.templates.find((x) => x.key === template) : undefined;
  const source = from ? r.workflows.find((x) => x.id === from) : undefined;
  const initial = tp ? draftFromTemplate(tp) : source ? copyOf(source, t("workflows.studio.copyName", { name: source.name })) : blankDraft();
  return <Studio initial={initial} catalog={catalog} prompting={r.prompting ?? null} runners={r.runners ?? null} />;
}
