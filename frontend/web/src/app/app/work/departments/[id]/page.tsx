import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { gw } from "@/lib/gateway";
import { getT } from "@/lib/i18n/server";
import { readPage } from "@/lib/page-read";
import { ReadFailed } from "@/components/ui/ReadFailed";
import { DepartmentView, type DepartmentRead } from "@/components/work/DepartmentView";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("dept.title") };
}

/**
 * A department in Work: its people with their numbers and its pace (done and added per week). The work module decides
 * who may open it (company followers, the head, managers whose people work there, its members as numbers only).
 */
export default async function DepartmentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9A-Za-z_-]{6,64}$/.test(id)) notFound();
  const r = await readPage(gw<DepartmentRead>(`/api/work/departments/${id}/status`));
  if (r.failed !== undefined) return <ReadFailed status={r.failed} />;
  return <DepartmentView data={r.data} />;
}
