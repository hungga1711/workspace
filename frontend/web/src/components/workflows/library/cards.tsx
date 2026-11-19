"use client";

import Link from "next/link";
import { useFormat, useT } from "@/lib/i18n/client";
import { cx, iconBtn } from "@/lib/ui";
import { card } from "@/components/ui/Bento";
import { Menu } from "@/components/ui/Menu";
import { CopyIcon, InfoIcon, MoreIcon, PencilIcon, TrashIcon } from "@/components/app/icons";
import { CategoryTile, EnvBadge } from "../bits";
import { duration } from "../Graph";
import { plainText } from "../plain";
import type { RunnerInfo, Workflow, WorkflowTemplate, WorkflowUsage } from "../types";
import { StepStrip, configOf, missingFor } from "./shared";

/**
 * A workflow as a card: its department tile, name and one line, where it runs, the pipeline's shape, what it asks at
 * Run, and how it has done in the last 30 days. The whole card opens the workflow; the menu edits, copies, removes.
 */
export function WorkflowCard({
  w,
  usage,
  onEdit,
  onDuplicate,
  onRemove,
}: {
  w: Workflow;
  /** undefined: the activity read failed, so the card says nothing rather than "not run yet". */
  usage: WorkflowUsage | null | undefined;
  onEdit: () => void;
  onDuplicate: () => void;
  onRemove: () => void;
}) {
  const t = useT();
  const f = useFormat();
  const c = configOf(w);
  const finished = usage ? usage.done30d + usage.failed30d : 0;
  const success = usage && finished ? Math.round((usage.done30d / finished) * 100) : null;
  return (
    <li className={cx(card, "group/wf relative flex min-w-0 flex-col gap-3 rounded-xl p-4 has-[[aria-expanded=true]]:z-20")}>
      <div className="flex min-w-0 items-start gap-3">
        <CategoryTile category={w.category} />
        <div className="min-w-0 flex-1">
          <p className="text-ink m-0 line-clamp-2 text-[15px]/5 font-semibold tracking-[-0.01em]" title={w.name}>
            {w.name}
          </p>
          <p className="text-ink-2 m-0 mt-0.5 line-clamp-1 text-[13px]">{plainText(w.description) || t(`workflows.category.${w.category}`)}</p>
        </div>
        <span className="relative z-[2]">
          <Menu
            label={t("workflows.library.actions", { name: w.name })}
            align="right"
            items={[
              ...(w.canEdit ? [{ label: t("common.edit"), icon: <PencilIcon />, onSelect: onEdit }] : []),
              { label: t("workflows.library.duplicate"), icon: <CopyIcon />, onSelect: onDuplicate },
              ...(w.canEdit ? [{ label: t("common.delete"), icon: <TrashIcon />, danger: true, onSelect: onRemove }] : []),
            ]}
            trigger={
              <span className={cx(iconBtn, "-mr-1.5 -mt-1")}>
                <MoreIcon className="size-4" />
              </span>
            }
          />
        </span>
      </div>
      <span className="flex min-w-0">
        <EnvBadge env={c.environment} />
      </span>
      <StepStrip steps={w.steps} />
      {c.inputs.length ? (
        <p className="text-ink-2 m-0 line-clamp-1 text-xs">
          {t("workflows.library.asks")} <span className="text-ink-soft">{c.inputs.map((i) => i.label).join(", ")}</span>
        </p>
      ) : null}
      {usage !== undefined ? (
        <p className="border-divider text-ink-2 m-0 mt-auto flex flex-wrap gap-x-3 gap-y-0.5 border-t pt-3 text-xs tabular-nums" suppressHydrationWarning>
          {usage?.runs30d ? (
            <>
              <span>{t("workflows.library.runs30d", { count: usage.runs30d })}</span>
              {success !== null ? (
                <span className={cx("font-medium", success >= 80 ? "text-ok" : success < 50 ? "text-block" : "text-warn")}>{t("workflows.library.success", { pct: success })}</span>
              ) : null}
              {usage.avgSec ? <span>{t("workflows.library.avgTime", { time: duration(usage.avgSec) })}</span> : null}
            </>
          ) : usage?.lastRunAt ? (
            <span>{t("workflows.card.last", { ago: f.ago(usage.lastRunAt) })}</span>
          ) : (
            <span>{t("workflows.usage.never")}</span>
          )}
        </p>
      ) : null}
      <Link href={`/app/ai/workflows/${w.id}`} aria-label={t("workflows.detail.open", { name: w.name })} className="absolute inset-0 z-[1] rounded-[inherit]" />
    </li>
  );
}

/** What a workflow needs that is not connected yet, as one quiet line; nothing when it can run now. */
export function Missing({ what, className }: { what: ReturnType<typeof missingFor>; className?: string }) {
  const t = useT();
  if (!what) return null;
  return (
    <span className={cx("text-warn inline-flex min-w-0 items-center gap-1 text-xs [&_svg]:size-3.5 [&_svg]:shrink-0", className)}>
      <InfoIcon />
      <span className="min-w-0">{t(`workflows.library.needs.${what}`)}</span>
    </span>
  );
}

/** A template: the same anatomy as a workflow's card, plus what it is for. The whole card opens its preview. */
export function TemplateCard({ x, aiOn, runners, onOpen, compact }: { x: WorkflowTemplate; aiOn: boolean; runners: RunnerInfo[]; onOpen: () => void; compact?: boolean }) {
  const t = useT();
  const c = configOf(x);
  return (
    <li className={cx(card, "group/tpl relative flex min-w-0 flex-col gap-3 rounded-xl p-4")}>
      <div className="flex min-w-0 items-start gap-3">
        <CategoryTile category={x.category} size="sm" />
        <div className="min-w-0 flex-1">
          <p className="text-ink m-0 line-clamp-2 text-sm font-semibold tracking-[-0.01em]">{x.name}</p>
          <p className="text-ink-2 m-0 mt-0.5 line-clamp-2 text-[13px]">{plainText(x.description)}</p>
        </div>
      </div>
      <StepStrip steps={x.steps} />
      {!compact && x.uses?.length ? (
        <ul className="text-ink-soft m-0 grid list-none gap-0.5 p-0 text-xs">
          {x.uses.slice(0, 2).map((u, i) => (
            <li key={i} className="flex min-w-0 gap-1.5">
              <span aria-hidden="true" className="text-ink-2">
                ·
              </span>
              <span className="line-clamp-1 min-w-0">{u}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mt-auto flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <EnvBadge env={c.environment} />
        <Missing what={missingFor(c, aiOn, runners)} />
      </div>
      <button type="button" aria-label={t("workflows.library.preview", { name: x.name })} className="absolute inset-0 z-[1] rounded-[inherit]" onClick={onOpen} />
    </li>
  );
}
