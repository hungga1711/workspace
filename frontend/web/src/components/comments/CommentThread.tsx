"use client";

import { useState } from "react";
import { useDirectory } from "@/lib/people";
import { cx } from "@/lib/ui";
import { CommentEditor } from "./CommentEditor";
import { CommentEntry, type CommentLike } from "./CommentEntry";

/** Consecutive comments by one person within this gap read as one message: one face and name, then the lines. */
const GROUP_MS = 10 * 60_000;

/**
 * Comments oldest first, like a chat: the thread under a task, the replies under a page comment, the questions on a
 * request. The reader edits and deletes their own where the place allows it (`onEdit` / `onDelete` given).
 */
export function CommentThread<C extends CommentLike>({
  comments,
  onEdit,
  onDelete,
  lead,
  className,
}: {
  comments: C[];
  onEdit?: ((id: string, body: string) => void | Promise<void>) | undefined;
  onDelete?: ((id: string) => void | Promise<void>) | undefined;
  /** Above a comment's text (the passage a page comment quotes). */
  lead?: (c: C) => React.ReactNode;
  className?: string;
}) {
  const dir = useDirectory();
  const [editing, setEditing] = useState<string | null>(null);
  const rows = [...comments].sort((x, y) => new Date(x.createdAt).getTime() - new Date(y.createdAt).getTime());
  // A workflow's result is its own voice: never folded into its starter's messages, nor theirs into it.
  const same = (a: C | undefined, b: C) => !!a && a.authorId === b.authorId && (a.agent ?? null) === (b.agent ?? null);
  return (
    <ol className={cx("m-0 grid list-none grid-cols-[minmax(0,1fr)] p-0", className)}>
      {rows.map((c, i) => {
        const prev = rows[i - 1];
        const next = rows[i + 1];
        const extra = lead?.(c);
        // A comment with something of its own above its text (a quoted passage) always starts a message.
        const cont = !extra && same(prev, c) && new Date(c.createdAt).getTime() - new Date(prev!.createdAt).getTime() < GROUP_MS;
        const mine = c.authorId === dir.me;
        return (
          <li key={c.id}>
            <CommentEntry
              c={c}
              cont={cont}
              lead={extra}
              onEdit={mine && onEdit ? () => setEditing(c.id) : undefined}
              onDelete={mine && onDelete ? () => void onDelete(c.id) : undefined}
              editor={
                editing === c.id && onEdit ? (
                  <CommentEditor
                    body={c.body}
                    names={dir.names}
                    people={dir.people.map((x) => ({ id: x.userId, name: x.displayName }))}
                    onCancel={() => setEditing(null)}
                    onSave={(b) => {
                      setEditing(null);
                      void onEdit(c.id, b);
                    }}
                  />
                ) : undefined
              }
              className={cx("hover:bg-hover/50 -mx-2 rounded-lg px-2", cont ? "pb-1.5 pt-0.5" : "pb-1.5 pt-2.5", next && same(c, next) ? "" : "mb-1.5")}
            />
          </li>
        );
      })}
    </ol>
  );
}
