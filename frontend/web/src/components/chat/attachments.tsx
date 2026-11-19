"use client";

import { useT } from "@/lib/i18n/client";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { cx } from "@/lib/ui";
import { FileIcon } from "@/components/app/icons";
import { useToast } from "@/components/ui/Toast";

export interface Attachment {
  fileId: string;
  name: string;
  size: number;
  contentType: string;
}

export const CHAT_MAX_BYTES = 50 * 1024 * 1024;
export const kb = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Browser → presigned PUT → storage; the chat module only authorizes and records. */
export async function uploadChatFile(channelId: string, file: File): Promise<Attachment> {
  const type = file.type || "application/octet-stream";
  const u = await api<{ fileId: string; uploadUrl: string }>(`chat/channels/${channelId}/files`, { method: "POST", body: { name: file.name, contentType: type, size: file.size } });
  const put = await fetch(u.uploadUrl, { method: "PUT", headers: { "content-type": type }, body: file });
  if (!put.ok) throw new Error("upload failed");
  return api<Attachment>(`chat/files/${u.fileId}/confirm`, { method: "POST" });
}

async function open(fileId: string, inline = false) {
  const r = await api<{ url: string }>(`chat/files/${fileId}/download${inline ? "?inline=1" : ""}`);
  return r.url;
}

/** Starts a download through a short-lived link; a refusal (file deleted, no longer allowed) is said, not swallowed. */
function useDownload() {
  const t = useT();
  const toast = useToast();
  return (fileId: string) =>
    void open(fileId)
      .then((u) => {
        window.location.href = u;
      })
      .catch(() => toast({ message: t("common.actionFailed") }));
}

/** Image thumbnails load through a short-lived link; other files are chips that download on click. */
export function AttachmentList({ items }: { items: Attachment[] }) {
  const t = useT();
  const download = useDownload();
  if (!items?.length) return null;
  return (
    <ul className="m-0 mt-1.5 flex list-none flex-wrap gap-2 p-0" aria-label={t("chat.files.attachments")}>
      {items.map((a) =>
        a.contentType.startsWith("image/") ? (
          <ImageThumb key={a.fileId} a={a} />
        ) : (
          <li key={a.fileId}>
            <button
              type="button"
              onClick={() => download(a.fileId)}
              className="border-hairline bg-surface hover:bg-hover flex max-w-72 items-center gap-2 rounded-md border px-3 py-2 text-left text-sm"
            >
              <FileIcon className="text-brand-text size-5 shrink-0" />
              <span className="min-w-0">
                <span className="block truncate font-medium">{a.name}</span>
                <span className="text-ink-2 text-xs">{kb(a.size)}</span>
              </span>
            </button>
          </li>
        ),
      )}
    </ul>
  );
}

function ImageThumb({ a }: { a: Attachment }) {
  const t = useT();
  const download = useDownload();
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    void open(a.fileId, true)
      .then(setSrc)
      .catch(() => setSrc(null));
  }, [a.fileId]);
  return (
    <li>
      <button
        type="button"
        onClick={() => download(a.fileId)}
        className={cx("border-hairline bg-hover block overflow-hidden rounded-md border", !src && "h-32 w-48")}
        aria-label={t("chat.files.download", { name: a.name })}
      >
        {src ? <img src={src} alt={a.name} className="max-h-60 min-h-16 min-w-16 max-w-72 object-contain" /> : null}
      </button>
    </li>
  );
}
