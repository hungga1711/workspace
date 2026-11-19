import { ApprovalDetail } from "@/components/work/ApprovalDetail";
import { loadApproval } from "@/components/work/loaders";
import { ReadFailed } from "@/components/ui/ReadFailed";
import { readPage } from "@/lib/page-read";
import type { Metadata } from "next";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const r = await loadApproval(id).catch(() => null);
  return r ? { title: r.code ? `${r.code} · ${r.title}` : r.title } : {};
}

/** A request by its id or its code (`/app/work/approvals/YC-007`). */
export default async function ApprovalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Someone else's request says "no access" (403); a failed read offers a retry; only a missing one is a 404.
  const r = await readPage(loadApproval(id));
  if (!r.data) return <ReadFailed status={r.failed} />;
  return <ApprovalDetail a={r.data} />;
}
