"use client";

import { cx } from "@/lib/ui";
import { Markdown } from "@/lib/markdown";
import { useDirectory } from "@/lib/people";
import { PaperclipIcon } from "@/components/app/icons";
import { RichText } from "@/components/chat/RichText";
import type { Attachment } from "@/components/chat/attachments";

const FILE_LINK = /(!?)\[([^\]]*)\]\((\/app\/files\/[\w-]+)\)/g;
/**
 * Text written as a document (headings, lists, a table, a rule, code): a workflow's result or a pasted report. It
 * renders as Markdown; a chat-like comment (with @mentions) keeps the chat renderer.
 */
const BLOCKS = /^(#{1,6} |\s*[-*+] |\s*\d+[.)] |\s*\|.*\|\s*$|-{3,}\s*$|```)/m;
export const looksLikeDocument = (body: string) => BLOCKS.test(body) && !/<@[\w-]+>/.test(body);

/**
 * What a comment stores for the files sent with it: its text, then one Markdown link per file ("!" for a picture),
 * each pointing at /app/files/<id>. `CommentBody` reads them back.
 */
export function withAttachmentLinks(text: string, attachments: Attachment[] = []): string {
  const links = attachments.map((a) => `${a.contentType.startsWith("image/") ? "!" : ""}[${a.name.replace(/[[\]]/g, "")}](/app/files/${a.fileId})`);
  return [text.trim(), ...links].filter(Boolean).join("\n");
}

/**
 * A comment's text wherever comments are read (tasks, requests, pages), with the files sent with it: pictures inline
 * (click for full size), other files as links. @mentions open the person's card (RichText).
 */
export function CommentBody({ body, doc }: { body: string; /** Always a document (a workflow's result). */ doc?: boolean }) {
  const dir = useDirectory();
  const files = [...body.matchAll(FILE_LINK)];
  const text = body.replace(FILE_LINK, "").trim();
  return (
    <>
      {text ? (
        doc || looksLikeDocument(text) ? (
          <div className="whitespace-normal">
            <Markdown source={text} />
          </div>
        ) : (
          <RichText text={text} names={dir.names} me={dir.me} />
        )
      ) : null}
      {files.length ? (
        <span className={cx("flex flex-wrap gap-2", text && "mt-2")}>
          {files.map(([, img, name, href]) =>
            img ? (
              <a key={href} href={href} target="_blank" rel="noopener noreferrer" className="block">
                <img src={href} alt={name} loading="lazy" className="border-hairline bg-surface max-h-60 max-w-full rounded-lg border object-contain" />
              </a>
            ) : (
              <a
                key={href}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="border-hairline bg-surface text-ink inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs no-underline"
              >
                <PaperclipIcon className="size-3.5" />
                {name}
              </a>
            ),
          )}
        </span>
      ) : null}
    </>
  );
}
