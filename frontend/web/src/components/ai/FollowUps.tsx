"use client";

import { useT } from "@/lib/i18n/client";

/**
 * The next questions worth asking after an answer, chosen by the server from what it read (progress.ts, no AI call).
 * A tap puts the question in the box, ready to send or change; nothing is sent by itself.
 */
export function FollowUps({ items, onPick }: { items: string[] | undefined; onPick: ((text: string) => void) | undefined }) {
  const t = useT();
  if (!items?.length || !onPick) return null;
  return (
    <div className="mt-2.5 flex flex-wrap gap-1.5" role="group" aria-label={t("aiw.chat.followUps")}>
      {items.map((q) => (
        <button
          key={q}
          type="button"
          onClick={() => onPick(q)}
          className="border-hairline text-ink-2 hover:bg-hover hover:text-ink max-w-full truncate rounded-full border px-3 py-1 text-xs transition-colors"
        >
          {q}
        </button>
      ))}
    </div>
  );
}
