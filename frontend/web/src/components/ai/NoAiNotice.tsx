"use client";

import Link from "next/link";
import { InfoIcon } from "@/components/app/icons";
import { useT } from "@/lib/i18n/client";
import { cx } from "@/lib/ui";

/**
 * Hỏi đáp without a connected AI: one plain banner at the top,
 * on the empty screen and in a conversation alike. It says what still works (tasks from requests, or the built-in
 * lookups) and who can fix it: an admin gets the link to Admin › AI connections, anyone else is told to ask one.
 * `off`: a connection exists but AI is switched off for the workspace.
 */
export function NoAiNotice({ mode, admin, off = false, className }: { mode: "taskOnly" | "builtIn"; admin: boolean; off?: boolean; className?: string }) {
  const t = useT();
  return (
    <div role="status" className={cx("bg-warn-wash border-warn/20 text-ink flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border px-3.5 py-2.5 text-sm", className)}>
      <InfoIcon className="text-warn size-4 shrink-0" />
      <p className="m-0 min-w-0 flex-1">
        <span className="font-medium">{t(off ? "aiw.noAi.off" : "aiw.noAi.title")}</span>
        <span className="text-ink-2">
          {" · "}
          {t(mode === "taskOnly" ? "aiw.noAi.taskOnly" : "aiw.noAi.builtIn")}
          {admin ? null : ` ${t("aiw.noAi.askAdmin")}`}
        </span>
      </p>
      {admin ? (
        <Link
          href="/admin/workspace/ai"
          className="bg-surface ring-hairline text-ink hover:bg-hover inline-flex h-8 shrink-0 items-center rounded-lg px-3 text-[13px] font-medium no-underline ring-1 transition-colors"
        >
          {t(off ? "aiw.noAi.turnOn" : "aiw.noAi.connect")}
        </Link>
      ) : null}
    </div>
  );
}
