"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { useT } from "@/lib/i18n/client";
import { useDirectory } from "@/lib/people";
import { cx } from "@/lib/ui";
import { uploadWorkFile } from "@/lib/work-files";
import { useToast } from "@/components/ui/Toast";
import type { Attachment } from "@/components/chat/attachments";
import { withAttachmentLinks } from "@/components/comments/CommentBody";
import { CommentComposer } from "@/components/comments/CommentComposer";
import { CommentThread } from "@/components/comments/CommentThread";

interface Comment {
  id: string;
  parentId: string | null;
  authorId: string;
  body: string;
  quote: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  createdAt: string;
}

/**
 * Page comments: threads of one level, resolve to tidy up, notify the page's people. What is a page's own stays here
 * (the quoted passage, replies, resolving); a comment and the box it is written in are the shared ones (comments/).
 */
export function DocComments({
  docId,
  canResolve,
  quote,
  onQuoteDone,
  onQuotes,
  onShowQuote,
}: {
  docId: string;
  canResolve: boolean;
  /** Text picked in the page for a new inline comment. */
  quote?: string | null;
  onQuoteDone?: () => void;
  /** The quotes of open comments, so the page can mark them. */
  onQuotes?: (quotes: string[]) => void;
  /** A comment's quote was clicked: show it in the page. */
  onShowQuote?: (quote: string) => void;
}) {
  const t = useT();
  const dir = useDirectory();
  const toast = useToast();
  const [list, setList] = useState<Comment[]>([]);
  const [reply, setReply] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const load = () =>
    api<{ comments: Comment[] }>(`work/docs/${docId}/comments`)
      .then((r) => setList(r.comments))
      .catch(() => undefined);
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);
  useEffect(() => {
    onQuotes?.(list.filter((c) => !c.parentId && !c.resolvedAt && c.quote).map((c) => c.quote!));
  }, [list, onQuotes]);
  const post = async (text: string, attachments: Attachment[], parentId: string | null, withQuote: string | null = null) => {
    const body = withAttachmentLinks(text, attachments);
    if (!body) return;
    try {
      await api(`work/docs/${docId}/comments`, { method: "POST", body: { body, parentId, ...(withQuote ? { quote: withQuote } : {}) } });
    } catch {
      toast({ message: t("common.actionFailed") });
    }
    await load();
  };
  const resolve = async (c: Comment) => {
    await api(`work/docs/${docId}/comments/${c.id}/resolve`, { method: "POST", body: { resolved: !c.resolvedAt } });
    await load();
  };
  // Only its author deletes a comment (the server's rule); a deleted comment takes its replies with it.
  const remove = async (id: string) => {
    if (!window.confirm(t("work.taskdetailview.comment_deleteConfirm"))) return;
    try {
      await api(`work/docs/${docId}/comments/${id}`, { method: "DELETE" });
    } catch {
      toast({ message: t("work.taskdetailview.comment_deleteFailed") });
    }
    await load();
  };
  // Files sent with a comment are stored with the page.
  const upload = (file: File) => uploadWorkFile(file, { type: "document", id: docId });
  const roots = list.filter((c) => !c.parentId && (showResolved || !c.resolvedAt));
  const resolvedCount = list.filter((c) => !c.parentId && c.resolvedAt).length;
  const action = "text-ink-2 hover:text-ink text-sm font-medium";
  return (
    <section aria-labelledby="comments-h" className="border-divider mt-12 border-t pt-6 print:hidden">
      <div className="mb-4 flex items-center gap-3">
        <h2 id="comments-h" className="m-0 flex-1 text-base font-semibold">
          {t("docs.comments.title", { count: roots.length })}
        </h2>
        {resolvedCount ? (
          <button type="button" className="text-ink-2 hover:text-ink text-sm underline" onClick={() => setShowResolved((s) => !s)}>
            {t(showResolved ? "docs.comments.hideResolved" : "docs.comments.showResolved", { count: resolvedCount })}
          </button>
        ) : null}
      </div>
      <ul className="m-0 grid list-none gap-4 p-0">
        {roots.map((c) => (
          <li key={c.id} className={cx("bg-surface shadow-card rounded-xl px-4 pb-3 pt-1.5", c.resolvedAt && "opacity-60")}>
            <CommentThread
              comments={[c, ...list.filter((r) => r.parentId === c.id)]}
              onDelete={remove}
              lead={(x) =>
                x.quote ? (
                  <button
                    type="button"
                    onClick={() => onShowQuote?.(x.quote!)}
                    className="border-accent text-ink-2 hover:text-ink my-1 block border-l-2 pl-2 text-left text-sm italic"
                    title={t("docs.comments.showInPage")}
                  >
                    {x.quote}
                  </button>
                ) : null
              }
            />
            <div className="flex gap-3 pl-9">
              <button type="button" className={action} onClick={() => setReply(reply === c.id ? null : c.id)}>
                {t(reply === c.id ? "common.cancel" : "docs.comments.reply")}
              </button>
              {canResolve || c.authorId === dir.me ? (
                <button type="button" className={action} onClick={() => void resolve(c)}>
                  {t(c.resolvedAt ? "docs.comments.reopen" : "docs.comments.resolve")}
                </button>
              ) : null}
            </div>
            {reply === c.id ? (
              <div className="mt-2 pl-9">
                <CommentComposer
                  id={`doc-reply-${c.id}`}
                  draftKey={`doc-reply:${c.id}`}
                  label={t("docs.comments.reply")}
                  placeholder={t("docs.comments.placeholder")}
                  sendLabel={t("docs.comments.send")}
                  maxLength={10000}
                  autoFocus
                  onUpload={upload}
                  onSubmit={(text, files) => void post(text, files, c.id).then(() => setReply(null))}
                />
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      <div id="doc-comment-form" className="mt-4 grid gap-2">
        {quote ? (
          <div className="border-accent bg-accent-wash/60 flex items-start gap-2 rounded-md border-l-2 px-2 py-1.5 text-sm">
            <span className="text-ink-2 min-w-0 flex-1 italic" data-testid="comment-quote">
              {quote}
            </span>
            <button type="button" className="text-ink-2 hover:text-ink text-xs font-medium" onClick={() => onQuoteDone?.()}>
              {t("common.cancel")}
            </button>
          </div>
        ) : null}
        <CommentComposer
          // A passage just picked in the page: a fresh box, focused, for the comment about it.
          key={quote ?? "page"}
          id="doc-comment"
          draftKey={`doc-comment:${docId}`}
          label={t("docs.comments.add")}
          placeholder={quote ? t("docs.comments.inlinePlaceholder") : t("docs.comments.placeholder")}
          sendLabel={t("docs.comments.send")}
          maxLength={10000}
          autoFocus={!!quote}
          onUpload={upload}
          onSubmit={(text, files) => void post(text, files, null, quote ?? null).then(() => onQuoteDone?.())}
        />
      </div>
    </section>
  );
}
