import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { gw } from "@/lib/gateway";
import { getT } from "@/lib/i18n/server";
import { btn } from "@/lib/ui";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { Studio } from "@/components/workflows/studio/Studio";
import { draftOf } from "@/components/workflows/studio/draft";
import type { ModelCatalog, Prompting, RunnerInfo, Workflow } from "@/components/workflows/types";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("workflows.editor.editTitle") };
}

/** A workflow in the studio. Only its creator and the people who manage the company's AI may edit it; others are told so. */
export default async function EditWorkflowPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const t = await getT();
  const [r, catalog] = await Promise.all([
    gw<{ workflows: Workflow[]; prompting?: Prompting; runners?: RunnerInfo[] }>("/api/work/workflows").catch(() => null),
    gw<ModelCatalog>("/api/ai/workflows/models").catch(() => null),
  ]);
  if (!r) return <LoadFailed className="bg-surface shadow-card rounded-xl px-5 py-4" />;
  const w = r.workflows.find((x) => x.id === id);
  if (!w) notFound();
  if (!w.canEdit)
    return (
      <div className="bg-surface shadow-card grid justify-items-start gap-3 rounded-xl px-5 py-4">
        <div>
          <h1 className="text-ink m-0 text-base font-semibold">{t("workflows.studio.noEditTitle")}</h1>
          <p className="text-ink-2 m-0 text-sm">{t("workflows.studio.noEditBody")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href={`/app/ai/workflows/${w.id}`} className={btn}>
            {t("workflows.studio.noEditBack")}
          </Link>
          <Link href={`/app/ai/workflows/new?from=${w.id}`} className={btn}>
            {t("workflows.studio.duplicate")}
          </Link>
        </div>
      </div>
    );
  return <Studio initial={draftOf(w)} catalog={catalog} prompting={r.prompting ?? null} runners={r.runners ?? null} />;
}
