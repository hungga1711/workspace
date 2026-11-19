"use client";

import { useFormat } from "@/lib/i18n/client";
import { Avatar } from "@/lib/people";
import { cx } from "@/lib/ui";
import { BotIcon } from "@/components/app/icons";
import { PersonTrigger } from "@/components/chat/PersonTrigger";

/** The list a log's rows sit in: a hairline down the faces' column joins them into one timeline. */
export const activityList = "before:bg-divider relative m-0 grid list-none p-0 before:absolute before:bottom-4 before:left-[11.5px] before:top-4 before:w-px";

/**
 * One line of a record's log (a task's history, a request's steps): who (their face opens their card; the AI has its
 * own mark), what happened, and when. `children` is the sentence; anything it quotes sits under it.
 */
export function ActivityRow({
  who,
  ai = false,
  at,
  tone,
  children,
}: {
  who: string;
  ai?: boolean;
  at: string;
  /** A decision: the face is ringed green (approved) or red (rejected). */
  tone?: "ok" | "block" | undefined;
  children: React.ReactNode;
}) {
  const { ago, dayLabel, time } = useFormat();
  return (
    <li className="relative grid grid-cols-[24px_minmax(0,1fr)_auto] items-start gap-x-3 py-1.5 text-[13px]/5">
      {ai ? (
        <span aria-hidden="true" className="bg-violet-wash text-violet-text ring-surface grid size-6 place-items-center rounded-full ring-2 [&_svg]:size-3.5">
          <BotIcon />
        </span>
      ) : (
        <PersonTrigger userId={who}>
          <Avatar id={who} size="xs" className={cx("ring-2", tone === "ok" ? "ring-ok-wash" : tone === "block" ? "ring-block-wash" : "ring-surface")} />
        </PersonTrigger>
      )}
      <div className="text-ink-2 m-0 min-w-0 pt-0.5 [overflow-wrap:anywhere]">{children}</div>
      <time suppressHydrationWarning dateTime={at} title={`${dayLabel(at)} ${time(at)}`} className="text-ink-2 whitespace-nowrap pt-0.5 text-xs tabular-nums">
        {ago(at)}
      </time>
    </li>
  );
}
