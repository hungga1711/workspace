"use client";

import Link from "next/link";
import { ArrowRightIcon, SparkleIcon } from "@/components/app/icons";
import { useT } from "@/lib/i18n/client";
import { cx } from "@/lib/ui";
import type { ToolChip } from "../mention-types";
import { nextSteps } from "./types";

/**
 * What to do after an answer, in one row: first the next steps that follow from the tools it used (a
 * screen to open, or a request put in the box), then the questions worth asking next (FollowUps' list, chosen by the
 * server). The same intent shows once, four at most. A tap only fills the box; nothing is sent by itself.
 *
 * `prefix` is put before what fills the box: "@AI " in a chat channel, so the text asks the AI there.
 */
export function NextSteps({
  tools,
  followUps,
  onPick,
  prefix = "",
  className,
}: {
  tools?: ToolChip[] | undefined;
  followUps?: string[] | undefined;
  onPick?: ((text: string) => void) | undefined;
  prefix?: string;
  className?: string;
}) {
  const t = useT();
  const steps = nextSteps(tools, followUps, (key) => ({ label: t(`aiw.answer.act.${key as "rebalance"}`), ask: t(`aiw.answer.ask.${key as "rebalance"}`) }), !!onPick);
  if (!steps.length) return null;
  const pill = "inline-flex h-7 max-w-full items-center gap-1.5 rounded-full px-3 text-xs transition-colors max-md:h-8 [&_svg]:size-3.5 [&_svg]:shrink-0";
  const action = cx(pill, "bg-accent-wash text-accent-text hover:bg-accent-wash/70 font-medium");
  const question = cx(pill, "border-hairline text-ink-2 hover:bg-hover hover:text-ink border");
  return (
    <div className={cx("mt-3 flex flex-wrap gap-1.5", className)} role="group" aria-label={t("aiw.chat.followUps")} data-testid="next-steps">
      {steps.map((s) =>
        s.url ? (
          <Link key={s.id} href={s.url} className={cx(action, "no-underline")}>
            <span className="truncate">{s.label}</span>
            <ArrowRightIcon />
          </Link>
        ) : (
          <button key={s.id} type="button" className={s.kind === "action" ? action : question} title={s.text} onClick={() => onPick?.(`${prefix}${s.text}`)}>
            {s.kind === "action" ? <SparkleIcon /> : null}
            <span className="truncate">{s.label}</span>
          </button>
        ),
      )}
    </div>
  );
}
