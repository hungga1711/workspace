"use client";

import { useState } from "react";
import { api } from "@/lib/client";
import { useT } from "@/lib/i18n/client";
import { cx } from "@/lib/ui";
import { CheckIcon } from "@/components/app/icons";

/** A poll on a chat message: question, options, one or several choices, live counts. */
export interface PollState {
  question: string;
  options: { id: string; text: string }[];
  multi: boolean;
  closed: boolean;
  voters: number;
  votes: { option: string; count: number; mine?: boolean }[];
}

export function PollCard({ messageId, poll, onChange }: { messageId: string; poll: PollState; onChange: (p: PollState) => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const mine = new Set(poll.votes.filter((v) => v.mine).map((v) => v.option));
  const count = (id: string) => poll.votes.find((v) => v.option === id)?.count ?? 0;
  const total = Math.max(
    1,
    poll.votes.reduce((n, v) => n + v.count, 0),
  );
  const pick = async (id: string) => {
    if (poll.closed || busy) return;
    const next = poll.multi ? (mine.has(id) ? [...mine].filter((x) => x !== id) : [...mine, id]) : mine.has(id) ? [] : [id];
    setBusy(true);
    try {
      const m = await api<{ poll: PollState }>(`chat/messages/${messageId}/vote`, { method: "POST", body: { optionIds: next } });
      onChange(m.poll);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="border-hairline bg-surface mt-2 grid max-w-md gap-2 rounded-xl border p-3" role="group" aria-label={t("chat.poll.label", { q: poll.question })}>
      <p className="m-0 text-sm font-semibold">{poll.question}</p>
      <p className="text-ink-2 m-0 -mt-1 text-xs">{poll.multi ? t("chat.poll.multi") : t("chat.poll.single")}</p>
      {poll.options.map((o) => {
        const n = count(o.id);
        const on = mine.has(o.id);
        return (
          <button
            key={o.id}
            type="button"
            aria-pressed={on}
            disabled={poll.closed || busy}
            onClick={() => void pick(o.id)}
            className={cx(
              "relative flex min-h-9 items-center gap-2 overflow-hidden rounded-lg border px-3 text-left text-sm transition-colors",
              on ? "border-brand-text/50" : "border-hairline hover:border-ink-2/30",
            )}
          >
            {/* The fill is the share of votes. */}
            <span className={cx("absolute inset-y-0 left-0", on ? "bg-brand-wash" : "bg-hover")} style={{ width: `${(n / total) * 100}%` }} aria-hidden="true" />
            <span
              className={cx(
                "relative grid size-4 shrink-0 place-items-center border",
                poll.multi ? "rounded-sm" : "rounded-full",
                on ? "border-brand-text bg-brand-text text-white" : "border-ink-2/40",
              )}
            >
              {on ? <CheckIcon className="size-3" /> : null}
            </span>
            <span className="relative min-w-0 flex-1 truncate">{o.text}</span>
            <span className="text-ink-2 relative font-mono text-xs tabular-nums">{n}</span>
          </button>
        );
      })}
      <p className="text-ink-2 m-0 text-xs">{t("chat.poll.voters", { count: poll.voters })}</p>
    </div>
  );
}
