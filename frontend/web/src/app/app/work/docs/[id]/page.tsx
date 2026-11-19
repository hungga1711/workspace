import { requireFeature } from "@/lib/features";
import { redirect } from "next/navigation";
import { aiStatus } from "@/lib/ai";
import type { Metadata } from "next";
import { gw, gwOnce } from "@/lib/gateway";
import { PageView, type PageContext, type PageDoc } from "@/components/docs/PageView";
import type { TreePage } from "@/components/docs/SpaceTree";
import { refParam } from "@/components/work/loaders";
import { readPage } from "@/lib/page-read";
import { ReadFailed } from "@/components/ui/ReadFailed";

type DocResponse = { document: PageDoc; content: string; html: string; format: "markdown" | "html"; context: PageContext };

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  await requireFeature("docs");
  if (id === "new") return {};
  const r = await gwOnce<DocResponse>(`/api/work/docs/${refParam(id)}`).catch(() => null);
  return r?.document.title ? { title: r.document.title } : {};
}

/** A documentation page: the space's tree, the page, child pages and comments. */
export default async function DocPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ edit?: string; new?: string }> }) {
  const { id } = await params;
  if (id === "new") redirect("/app/work/docs?new=page");
  const sp = await searchParams;
  const [r, ai] = await Promise.all([readPage(gwOnce<DocResponse>(`/api/work/docs/${refParam(id)}`)), aiStatus()]);
  if (!r.data) return <ReadFailed status={r.failed} />;
  const d = r.data;
  const tree = d.context.space
    ? await gw<{ space: { canCreate: boolean; canManage: boolean }; pages: TreePage[] }>(`/api/work/spaces/${d.context.space.key}`).catch(() => ({
        space: { canCreate: false, canManage: false },
        pages: [] as TreePage[],
      }))
    : { space: { canCreate: false, canManage: false }, pages: [] as TreePage[] };
  return (
    <PageView
      key={d.document.id}
      doc={d.document}
      content={d.html}
      ctx={{ ...d.context, format: d.format }}
      tree={tree.pages}
      canCreate={tree.space.canCreate}
      canManage={tree.space.canManage}
      aiEnabled={ai.configured}
      startEditing={sp.edit === "1"}
      // A draft reopened from the tree is still "new": its banner says nobody sees it yet, and Huỷ removes it.
      fresh={(sp.new === "1" && d.document.version <= 1) || !!d.document.draft}
    />
  );
}
