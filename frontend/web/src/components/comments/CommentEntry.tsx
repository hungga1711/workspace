"use client";

import { useFormat, useT } from "@/lib/i18n/client";
import { Avatar, useDirectory } from "@/lib/people";
import { cx } from "@/lib/ui";
import { Menu } from "@/components/ui/Menu";
import { BotIcon, MoreIcon, PencilIcon, TrashIcon } from "@/components/app/icons";
import { PersonTrigger } from "@/components/chat/PersonTrigger";
import { CommentBody } from "./CommentBody";

export interface CommentLike {
  id: string;
  authorId: string;
  body: string;
  createdAt: string;
  editedAt?: string | null;
  /** Written by a workflow's agent (its name); the author is who started it. */
  agent?: string | null;
}

/**
 * One comment, the same on a task, a request and a page: the author's face and name (both open their profile card),
 * when, "edited", the text with its files, and "⋯" for what the reader may do to it. A comment that continues the one
 * above it (`cont`) drops the face and name and shows its time on hover instead.
 */
export function CommentEntry({
  c,
  cont = false,
  onEdit,
  onDelete,
  editor,
  lead,
  className,
}: {
  c: CommentLike;
  cont?: boolean;
  /** Present when the reader may edit / delete this comment. */
  onEdit?: (() => void) | undefined;
  onDelete?: (() => void) | undefined;
  /** Shown in place of the text while the comment is being edited. */
  editor?: React.ReactNode;
  /** Above the text: what the comment is about (the passage a page comment quotes). */
  lead?: React.ReactNode;
  className?: string;
}) {
  const t = useT();
  const { ago, dayLabel, time } = useFormat();
  const dir = useDirectory();
  const stamp = (iso: string) => `${dayLabel(iso)} ${time(iso)}`;
  const menu =
    (onEdit || onDelete) && !editor ? (
      <span className="opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
        <Menu
          align="right"
          label={t("work.taskdetailview.comment_actions")}
          items={[
            ...(onEdit ? [{ label: t("common.edit"), icon: <PencilIcon />, onSelect: onEdit }] : []),
            ...(onDelete ? [{ label: t("common.delete"), danger: true, icon: <TrashIcon />, onSelect: onDelete }] : []),
          ]}
          trigger={
            <span className="text-ink-2 hover:bg-hover hover:text-ink grid size-7 place-items-center rounded-md">
              <MoreIcon className="size-4" />
            </span>
          }
        />
      </span>
    ) : null;
  return (
    <div className={cx("group grid grid-cols-[24px_minmax(0,1fr)] gap-x-3", className)}>
      {cont ? (
        <time
          suppressHydrationWarning
          dateTime={c.createdAt}
          title={stamp(c.createdAt)}
          className="text-ink-2 pt-1 text-right text-xs tabular-nums opacity-0 group-hover:opacity-100"
        >
          {time(c.createdAt)}
        </time>
      ) : c.agent ? (
        <span aria-hidden="true" className="bg-accent-wash text-accent-text mt-px grid size-6 place-items-center rounded-full">
          <BotIcon className="size-3.5" />
        </span>
      ) : (
        // The author opens their profile card on hover or click, like on a chat message.
        <PersonTrigger userId={c.authorId} className="mt-px block self-start">
          <Avatar id={c.authorId} size="sm" />
        </PersonTrigger>
      )}
      <article className="min-w-0">
        {cont ? null : (
          <header className="flex min-h-6 min-w-0 items-center gap-2">
            {c.agent ? (
              // "AI" is the assistant answering a mention (ai/mention); any other name is a workflow's step.
              <span
                className="text-ink truncate text-[13px] font-semibold"
                title={t(c.agent === "AI" ? "work.taskdetailview.assistantAskedBy" : "work.taskdetailview.agentStartedBy", { name: dir.name(c.authorId) })}
              >
                {c.agent === "AI" ? t("work.taskdetailview.assistantAuthor") : t("work.taskdetailview.agentAuthor", { name: c.agent })}
              </span>
            ) : (
              <PersonTrigger userId={c.authorId} className="text-ink min-w-0 truncate rounded-sm text-[13px] font-semibold hover:underline">
                {dir.name(c.authorId)}
              </PersonTrigger>
            )}
            <time suppressHydrationWarning dateTime={c.createdAt} title={stamp(c.createdAt)} className="text-ink-2 shrink-0 text-xs">
              {ago(c.createdAt)}
            </time>
            {c.editedAt ? (
              <span className="text-ink-2 shrink-0 text-xs" title={stamp(c.editedAt)}>
                · {t("work.taskdetailview.comment_edited")}
              </span>
            ) : null}
            <span className="ml-auto">{menu}</span>
          </header>
        )}
        {lead}
        {editor ? (
          <div className="pt-1">{editor}</div>
        ) : (
          <div className="flex min-w-0 items-start gap-2">
            <div className="text-ink min-w-0 flex-1 whitespace-pre-wrap text-sm/6 [overflow-wrap:anywhere]">
              <CommentBody body={c.body} doc={!!c.agent} />
            </div>
            {cont ? <span className="-mt-0.5">{menu}</span> : null}
          </div>
        )}
      </article>
    </div>
  );
}
