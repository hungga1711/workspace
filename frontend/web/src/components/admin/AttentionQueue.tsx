"use client";

import Link from "next/link";
import { useFormat, useT } from "@/lib/i18n/client";
import type { MessageKey } from "@/lib/i18n/core";
import { useDirectory } from "@/lib/people";
import { btn, btnSm, cx } from "@/lib/ui";
import { InfoIcon } from "@/components/app/icons";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { adminCard } from "./AdminBits";
import type { AttentionSourceKey } from "./attention-sources";

/** One thing an admin has to look at, as a module's `GET attention` returns it (backend `<module>/attention.ts`). */
export interface AttentionItem {
  id: string;
  kind: string;
  /** broken: it does not work now. warning: it will not for long, or not fully. unknown: nobody knows. */
  severity: "broken" | "warning" | "unknown";
  since: string | null;
  name: string;
  detail?: string;
  ownerId?: string;
  count?: number;
  taskCode?: string;
  workflowId?: string;
  taskTitle?: string;
}
/** A module's answer; `items: null` when its read failed, which is said, never passed off as "nothing to do". */
export interface AttentionSource {
  key: AttentionSourceKey;
  items: AttentionItem[] | null;
}

type Cta = "fix" | "open" | "check" | "review" | "connect";
/** Each kind: its sentence, where it is fixed, and what the button says. `when`: the date is in the sentence itself. */
const KINDS: Record<string, { text: string; href: (i: AttentionItem) => string; cta: Cta; when?: "date" | "ago"; started?: boolean }> = {
  "ai.model.quota": { text: "aiModelQuota", href: () => "/admin/workspace/ai", cta: "review" },
  "ai.model.down": { text: "aiModelDown", href: () => "/admin/workspace/ai", cta: "review" },
  "ai.connection.failed": { text: "aiConnectionFailed", href: () => "/admin/workspace/ai", cta: "fix" },
  "ai.connection.unchecked": { text: "aiConnectionUnchecked", href: () => "/admin/workspace/ai", cta: "check" },
  "ai.mcp.signin": { text: "aiMcpSignin", href: () => "/admin/workspace/ai#mcp", cta: "fix" },
  "ai.mcp.failed": { text: "aiMcpFailed", href: () => "/admin/workspace/ai#mcp", cta: "fix" },
  "ai.mcp.calls": { text: "aiMcpCalls", href: () => "/admin/workspace/ai#mcp", cta: "review" },
  "ai.mcp.unchecked": { text: "aiMcpUnchecked", href: () => "/admin/workspace/ai#mcp", cta: "check" },
  "work.run.failed": { text: "runFailed", href: (i) => `/app/work/tasks/${i.taskCode}`, cta: "open", started: true },
  "work.run.approval": { text: "runApproval", href: (i) => `/app/work/tasks/${i.taskCode}`, cta: "open", started: true },
  "work.run.question": { text: "runQuestion", href: (i) => `/app/work/tasks/${i.taskCode}`, cta: "open", started: true },
  "work.run.noComputer": { text: "runNoComputer", href: (i) => `/app/work/tasks/${i.taskCode}`, cta: "open", started: true },
  "work.run.noCompanyComputer": { text: "runNoCompanyComputer", href: () => "/app/ai/connect", cta: "connect", started: true },
  "work.sync.failed": { text: "syncFailed", href: () => "/admin/workspace/integrations", cta: "fix" },
  "work.sync.silent": { text: "syncSilent", href: () => "/admin/workspace/integrations", cta: "check" },
  "work.hub.failed": { text: "hubFailed", href: () => "/admin/workspace/integrations", cta: "fix" },
  "work.trigger.refused": { text: "triggerRefused", href: (i) => `/app/ai/workflows/${i.workflowId}`, cta: "review" },
  "platform.webhook.disabled": { text: "webhookDisabled", href: () => "/admin/workspace/integrations#hooks-h", cta: "fix" },
  "platform.webhook.failing": { text: "webhookFailing", href: () => "/admin/workspace/integrations#hooks-h", cta: "review" },
  "identity.key.expired": { text: "keyExpired", href: () => "/admin/workspace/integrations#keys-h", cta: "fix", when: "ago" },
  "identity.key.expiring": { text: "keyExpiring", href: () => "/admin/workspace/integrations#keys-h", cta: "fix", when: "date" },
};
const ORDER = { broken: 0, warning: 1, unknown: 2 } as const;
const TONE = { broken: "bg-block-wash text-block", warning: "bg-warn-wash text-warn", unknown: "bg-hover text-ink-2" } as const;
/** Shown at once; the rest opens on demand so a bad day does not push the overview off the screen. */
const FIRST = 6;

/**
 * Admin › Overview: everything that is broken or about to break, in one list, each with the way to fix it.
 * Every module answers for its own part (AI connections and outside tools, agent runs and task sync, webhooks, API
 * keys) and only to who may fix it; nothing here is dismissed by hand, an item goes when its cause does. What is not
 * known is said as that: an unchecked connection is "not known", and a part that could not be read is named with a
 * retry rather than counted as fine. With nothing to show, the section is not there.
 */
export function AttentionQueue({ sources }: { sources: AttentionSource[] }) {
  const t = useT();
  const { ago, shortDate } = useFormat();
  const dir = useDirectory();
  const failed = sources.filter((s) => s.items === null);
  const items = sources
    .flatMap((s) => s.items ?? [])
    .filter((i) => KINDS[i.kind])
    .sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || (b.since ?? "").localeCompare(a.since ?? ""));
  if (!items.length && !failed.length) return null;
  const row = (i: AttentionItem) => {
    const k = KINDS[i.kind]!;
    const when = i.since ? (k.when === "date" ? shortDate(i.since) : ago(i.since)) : "";
    const owner = i.ownerId ? dir.name(i.ownerId) : "";
    return (
      <li key={i.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
        <span className={cx("grid size-6 shrink-0 place-items-center rounded-md text-xs font-semibold", TONE[i.severity])} title={t(`admin.needs.severity.${i.severity}`)}>
          <span aria-hidden="true">{i.severity === "broken" ? "✕" : i.severity === "warning" ? "!" : "?"}</span>
          <span className="sr-only">{t(`admin.needs.severity.${i.severity}`)}</span>
        </span>
        <span className="grid min-w-0 flex-[1_1_16rem] gap-0.5">
          <span className="text-sm font-medium [overflow-wrap:anywhere]">
            {t(`admin.needs.k.${k.text}` as MessageKey, { name: i.name, count: i.count ?? 0, task: i.taskCode ?? "", when })}
          </span>
          {i.detail ? <span className="text-ink-soft line-clamp-2 font-mono text-xs [overflow-wrap:anywhere]">{i.detail}</span> : null}
          <span className="text-ink-2 text-xs" suppressHydrationWarning>
            {[
              i.taskTitle,
              // A deadline carries its date in the sentence; everything else says since when, or that nobody knows.
              k.when ? "" : when ? t("admin.needs.since", { when }) : t("admin.needs.sinceUnknown"),
              owner ? t(k.started ? "admin.needs.startedBy" : "admin.needs.by", { name: owner }) : "",
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </span>
        {/* Below 640px the action wraps under the text, at the text's edge. */}
        <Link href={k.href(i)} className={cx(btn, btnSm, "no-underline max-sm:ml-10")}>
          {t(`admin.needs.cta.${k.cta}`)}
        </Link>
      </li>
    );
  };
  return (
    <section aria-labelledby="needs-h" className={cx(adminCard, "grid gap-1 p-5 max-sm:p-4")}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 id="needs-h" className="m-0 min-w-0 text-sm/6 font-semibold tracking-[-0.01em]">
          {t("admin.needs.title")}
        </h2>
        {items.length ? (
          <span className="bg-block-wash text-block rounded-full px-2 py-0.5 text-xs font-medium tabular-nums">{t("admin.needs.count", { count: items.length })}</span>
        ) : null}
      </header>
      {items.length ? (
        <>
          <ul className="divide-divider-soft m-0 grid list-none divide-y p-0">{items.slice(0, FIRST).map(row)}</ul>
          {items.length > FIRST ? (
            <details className="group">
              <summary className="text-ink-2 hover:text-ink cursor-pointer py-1 text-xs font-medium group-open:hidden">{t("admin.needs.showAll", { count: items.length })}</summary>
              <ul className="divide-divider-soft border-divider-soft m-0 grid list-none divide-y border-t p-0">{items.slice(FIRST).map(row)}</ul>
            </details>
          ) : null}
        </>
      ) : (
        <p className="text-ink-2 m-0 flex items-center gap-1.5 py-1 text-sm">
          <InfoIcon className="size-4 shrink-0" />
          {t("admin.needs.clear")}
        </p>
      )}
      {/* A part that could not be read is not "fine": it is named, with a way to try again. */}
      {failed.map((s) => (
        <LoadFailed key={s.key} what={t("admin.needs.failedSource", { what: t(`admin.needs.source.${s.key}`) })} className="pt-1" />
      ))}
    </section>
  );
}
