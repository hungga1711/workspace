import { PeekModal } from "@/components/ui/PeekModal";
import { ApprovalDetail } from "@/components/work/ApprovalDetail";
import { loadApproval } from "@/components/work/loaders";
import { ReadFailed } from "@/components/ui/ReadFailed";
import { readPage } from "@/lib/page-read";
import { getT } from "@/lib/i18n/server";
import { approvalHref } from "@/lib/links";

/** A request opened from the inbox, Home or a list: a centred dialog (it is a decision), decided without leaving the page. */
export default async function ApprovalPeek({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [r, tx] = await Promise.all([readPage(loadApproval(id)), getT()]);
  if (!r.data)
    return (
      <PeekModal size="medium" title={tx("ops.title")} href={`/app/work/approvals/${encodeURIComponent(id)}`}>
        <ReadFailed status={r.failed} />
      </PeekModal>
    );
  const a = r.data;
  // The dialog's header gives the context (YC-007 · Mua sắm); the request's title is the body's one title.
  const kind = a.kind ? tx(`ops.kind_${a.kind}`) : null;
  const head = [a.code ?? tx("ops.title"), kind].filter(Boolean).join(" · ");
  return (
    <PeekModal size="medium" title={head} href={approvalHref(a)}>
      <ApprovalDetail a={a} peek />
    </PeekModal>
  );
}
