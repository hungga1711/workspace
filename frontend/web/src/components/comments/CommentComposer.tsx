"use client";

import { useDirectory } from "@/lib/people";
import { Composer } from "@/components/chat/Composer";
import type { Attachment } from "@/components/chat/attachments";

/**
 * The box a comment is written in, the same on a task, a request and a page: chat's composer in its comment form.
 * "@" suggests colleagues (they are notified), Enter or the button posts, Shift+Enter adds a line; files attach by
 * the paperclip, a paste or a drop where the place stores files (`onUpload`); unsent text is kept per `draftKey`.
 */
export function CommentComposer({
  id,
  draftKey,
  label,
  placeholder,
  onSubmit,
  onUpload,
  mentions = true,
  ai = false,
  maxLength,
  sendLabel,
  autoFocus,
}: {
  id: string;
  draftKey: string;
  label: string;
  placeholder: string;
  onSubmit: (body: string, attachments: Attachment[]) => void;
  /** Absent where the backend takes text only: no paperclip, paste or drop. */
  onUpload?: ((file: File) => Promise<Attachment>) | undefined;
  /** False where a mention would notify nobody (the backend does not read them): no "@" suggestions. */
  mentions?: boolean;
  /** Where the AI answers a comment that mentions it (a task): "AI" joins the "@" suggestions. */
  ai?: boolean;
  maxLength?: number;
  sendLabel?: string;
  autoFocus?: boolean;
}) {
  const dir = useDirectory();
  return (
    <Composer
      id={id}
      variant="comment"
      draftKey={draftKey}
      label={label}
      placeholder={placeholder}
      candidates={[
        // As in chat: "@AI" stays as written (it is not a person to notify); the screen that posts the comment asks the AI.
        ...(ai ? [{ id: "ai", name: "AI", agent: true }] : []),
        ...(mentions ? dir.people.filter((x) => x.userId !== dir.me).map((x) => ({ id: x.userId, name: x.displayName })) : []),
      ]}
      onSubmit={onSubmit}
      {...(onUpload ? { onUpload } : {})}
      {...(maxLength ? { maxLength } : {})}
      {...(sendLabel ? { sendLabel } : {})}
      {...(autoFocus ? { autoFocus } : {})}
    />
  );
}
