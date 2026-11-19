"use client";

import { useState } from "react";
import { useT } from "@/lib/i18n/client";
import { CloseIcon } from "@/components/app/icons";

export interface LinkPreview {
  id: string;
  url: string;
  siteName: string;
  title: string;
  description: string;
  image: boolean;
}

/**
 * Link previews under a message: site, title (the link) and a two-line description, with the thumbnail the server
 * stored when it fetched the page (never loaded from the site itself). The author can hide them.
 */
export function LinkPreviews({ messageId, items, onHide }: { messageId: string; items: LinkPreview[]; onHide?: () => void }) {
  const t = useT();
  const [broken, setBroken] = useState<Record<string, boolean>>({});
  if (!items.length) return null;
  return (
    <div className="group/previews relative mt-1.5 grid max-w-[520px] gap-1.5">
      {items.map((p) => (
        <a
          key={p.id}
          href={p.url}
          target="_blank"
          rel="noopener noreferrer nofollow"
          aria-label={`${t("chat.preview.label")}: ${p.title}`}
          className="border-hairline bg-surface hover:bg-hover border-l-accent/60 flex min-w-0 gap-3 rounded-lg border border-l-[3px] p-2.5 pl-3 no-underline transition-colors"
        >
          <span className="grid min-w-0 flex-1 content-start gap-0.5">
            <span className="text-ink-2 truncate text-xs">{p.siteName}</span>
            <span className="text-accent-text line-clamp-2 text-sm font-semibold">{p.title}</span>
            {p.description ? <span className="text-ink-2 line-clamp-2 text-xs/5">{p.description}</span> : null}
          </span>
          {p.image && !broken[p.id] ? (
            // The server's stored copy, so the CSP needs no outside image hosts.
            <img
              src={`/api/proxy/chat/messages/${encodeURIComponent(messageId)}/previews/${encodeURIComponent(p.id)}/image`}
              alt=""
              loading="lazy"
              decoding="async"
              width={64}
              height={64}
              onError={() => setBroken((b) => ({ ...b, [p.id]: true }))}
              className="bg-ground size-16 shrink-0 rounded-md object-cover"
            />
          ) : null}
        </a>
      ))}
      {onHide ? (
        <button
          type="button"
          onClick={onHide}
          aria-label={t("chat.preview.hide")}
          title={t("chat.preview.hide")}
          className="border-hairline bg-surface text-ink-2 hover:text-ink absolute -right-2 -top-2 grid size-6 place-items-center rounded-md border opacity-0 transition-opacity focus-visible:opacity-100 group-hover/previews:opacity-100 [@media(hover:none)]:opacity-100"
        >
          <CloseIcon className="size-3" />
        </button>
      ) : null}
    </div>
  );
}
