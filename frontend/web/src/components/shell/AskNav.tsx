"use client";

import Link from "next/link";
import { useT } from "@/lib/i18n/client";
import { cx, navActive, navIdle } from "@/lib/ui";
import { ApprovalIcon, BotIcon } from "@/components/app/icons";
import { useOpenAsks } from "@/components/workflows/useOpenAsks";

/**
 * The sidebar's "Đang chờ bạn" group (docs/architecture/agent-questions.md): one temporary item per open round of an
 * agent's questions ("T-142 · AI hỏi") and per run waiting for the reader's approval ("T-215 · Chờ duyệt"), each a
 * conversation where it is answered or approved, with a dot until done. Not a channel: it exists
 * only while the round is open and leaves the list once it closes. Nothing at all when nothing is asked.
 */
export function AskNav({ path, itemClass, groupClass }: { path: string; itemClass: string; groupClass: string }) {
  const t = useT();
  const asks = useOpenAsks();
  if (!asks.length) return null;
  return (
    <div role="group" aria-labelledby="ask-nav-h">
      <p id="ask-nav-h" className={groupClass}>
        {t("shell.nav.asking")}
      </p>
      {asks.map((a) => {
        const href = `/app/chat/ask/${a.runId}`;
        const active = path === href;
        return (
          <Link
            key={a.id}
            href={href}
            prefetch={false}
            aria-current={active ? "page" : undefined}
            aria-label={
              a.kind === "approval"
                ? t("workflows.ask.approvalLabel", { code: a.taskCode, title: a.taskTitle })
                : t("workflows.ask.itemLabel", { code: a.taskCode, count: a.count, title: a.taskTitle })
            }
            title={a.taskTitle}
            // Drawn exactly like a channel row: same weight, a bare tinted
            // glyph in the channel's "#" slot instead of a filled box; the dot says it waits for you.
            className={cx(itemClass, active ? cx(navActive, "font-normal") : navIdle)}
          >
            <span aria-hidden="true" className={cx("grid w-6 shrink-0 place-items-center [&_svg]:size-3.5", a.kind === "approval" ? "text-tangerine-text" : "text-violet-text")}>
              {a.kind === "approval" ? <ApprovalIcon /> : <BotIcon />}
            </span>
            <span className="flex-1 truncate">{t(a.kind === "approval" ? "workflows.ask.approvalItem" : "workflows.ask.item", { code: a.taskCode })}</span>
            <span className="bg-signal size-2 shrink-0 rounded-full" aria-hidden="true" />
          </Link>
        );
      })}
    </div>
  );
}
