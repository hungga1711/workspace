"use client";

import { ReactionArt } from "./ReactionArt";
import * as m from "motion/react-m";
import { useT } from "@/lib/i18n/client";
import { cx } from "@/lib/ui";
import { useDialog } from "@/components/app/useDialog";
import { Portal } from "@/components/ui/Portal";
import { SmileIcon } from "@/components/app/icons";

export interface SheetAction {
  label: string;
  icon: React.ReactNode;
  onSelect: () => void;
  danger?: boolean;
}

/**
 * A message's actions on a touch screen, where there is no hover toolbar: a long press opens this sheet with a row
 * of quick reactions and the same actions as the desktop toolbar and its "⋯" menu.
 */
export function MessageSheet({
  title,
  quick,
  onReact,
  onMoreReactions,
  actions,
  reactions = [],
  onClose,
}: {
  title: string;
  /** Who reacted with what, in words (no hover on a phone to show it). */
  reactions?: { emoji: string; text: string }[];
  quick: string[];
  onReact: (emoji: string) => void;
  onMoreReactions: () => void;
  actions: SheetAction[];
  onClose: () => void;
}) {
  const t = useT();
  const ref = useDialog<HTMLDivElement>(onClose);
  const run = (f: () => void) => {
    onClose();
    f();
  };
  return (
    <Portal>
      <m.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.12 }}
        className="fixed inset-0 z-[70] bg-black/40"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <m.div
          ref={ref}
          role="dialog"
          aria-modal="true"
          aria-label={title}
          initial={{ y: 24, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ duration: 0.18, ease: [0.2, 0.7, 0.2, 1] }}
          className="bg-surface absolute inset-x-0 bottom-0 max-h-[85dvh] overflow-y-auto rounded-t-2xl pb-[calc(0.5rem+env(safe-area-inset-bottom))]"
        >
          <span className="bg-hairline mx-auto mb-1 mt-2 block h-1 w-10 rounded-full" aria-hidden="true" />
          <div className="flex items-center justify-between gap-1 px-4 py-2" role="group" aria-label={t("chat.conv.pickReaction")}>
            {quick.map((e) => (
              <button
                key={e}
                type="button"
                onClick={() => run(() => onReact(e))}
                aria-label={t("chat.conv.reactWith", { emoji: e })}
                className="bg-ground grid size-11 place-items-center rounded-full text-xl"
              >
                <ReactionArt emoji={e} size={26} />
              </button>
            ))}
            <button
              type="button"
              onClick={() => run(onMoreReactions)}
              aria-label={t("chat.conv.react")}
              className="bg-ground text-ink-2 grid size-11 place-items-center rounded-full"
            >
              <SmileIcon className="size-5" />
            </button>
          </div>
          {reactions.length ? (
            <section aria-label={t("chat.reactors.sheetTitle")} className="border-divider grid gap-1.5 border-t px-4 py-3">
              {reactions.map((r) => (
                <p key={r.emoji} className="m-0 flex items-start gap-2 text-sm">
                  <span className="w-6 shrink-0 text-center text-base/5" aria-hidden="true">
                    {r.emoji}
                  </span>
                  <span className="text-ink-2 min-w-0">{r.text}</span>
                </p>
              ))}
            </section>
          ) : null}
          <ul className="divide-divider-soft border-divider m-0 list-none divide-y border-t p-0">
            {actions.map((a) => (
              <li key={a.label}>
                <button
                  type="button"
                  onClick={() => run(a.onSelect)}
                  className={cx("flex min-h-12 w-full items-center gap-3 px-5 text-left text-[14px]", a.danger ? "text-block" : "text-ink", "active:bg-hover")}
                >
                  <span className={cx("grid size-5 place-items-center", a.danger ? "text-block" : "text-ink-2")}>{a.icon}</span>
                  {a.label}
                </button>
              </li>
            ))}
          </ul>
        </m.div>
      </m.div>
    </Portal>
  );
}
