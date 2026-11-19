"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { useFormat, useT } from "@/lib/i18n/client";
import { cx } from "@/lib/ui";
import { McpMonogram } from "@/components/ai/McpMonogram";
import { ChatIcon, CheckIcon, CloseIcon, ExpandIcon, RefreshIcon } from "@/components/app/icons";
import { tileOf, type CardState, type WorkLink } from "./types";

const STATE_TONE: Record<CardState, string> = {
  open: "bg-ok-wash text-ok",
  draft: "bg-hover text-ink-soft",
  merged: "bg-violet-wash text-violet-text",
  closed: "bg-block-wash text-block",
  done: "bg-ok-wash text-ok",
  none: "",
};
const CHECK_TONE = { passing: "text-ok", failing: "text-block", pending: "text-warn" } as const;
const iconBtn = "text-ink-2 hover:bg-hover hover:text-ink grid size-7 shrink-0 place-items-center rounded-md disabled:opacity-50 [&_svg]:size-3.5";

/**
 * One piece of linked work as a card (the integrations hub): a pull or merge request with its state,
 * branches, checks and reviewers; an issue; a design with its preview, opened inside the page on request. Drawn by the
 * card's kind, whatever tool it comes from. A link whose tool is not connected is still a link, and says what
 * connecting would add.
 */
export function WorkCard({
  link,
  task,
  onRefresh,
  onRemove,
  busy,
}: {
  link: WorkLink;
  /** In a project's list: the task the work belongs to, shown under it. */
  task?: React.ReactNode;
  onRefresh?: (() => void) | undefined;
  onRemove?: (() => void) | undefined;
  busy?: boolean;
}) {
  const t = useT();
  const { ago, number } = useFormat();
  const c = link.card;
  const tile = tileOf(link.provider, link.providerName);
  const [embed, setEmbed] = useState(false);
  const facts = c
    ? [c.ref, c.branch ? (c.target ? `${c.branch} → ${c.target}` : c.branch) : "", c.author ?? "", c.updatedAt ? t("hub.card.updated", { when: ago(c.updatedAt) }) : ""].filter(
        Boolean,
      )
    : [];
  return (
    <li className="ring-hairline bg-surface group grid min-w-0 gap-2 rounded-xl p-3 ring-1 ring-inset">
      <div className="flex min-w-0 items-start gap-3 max-sm:gap-2.5">
        {c?.kind === "design" && link.hasThumbnail ? <Thumbnail link={link} alt={c.title} /> : <McpMonogram mono={tile.mono} tone={tile.tone} />}
        <div className="grid min-w-0 flex-1 gap-1">
          <div className="flex min-w-0 items-center gap-2">
            <a
              href={link.url}
              target="_blank"
              rel="noreferrer"
              className="text-ink min-w-0 text-sm font-medium no-underline [overflow-wrap:anywhere] hover:underline max-sm:line-clamp-2 sm:truncate"
              title={c?.title ?? link.url}
            >
              {c?.title ?? link.url.replace(/^https?:\/\//, "")}
            </a>
            {c && c.state !== "none" ? (
              <span className={cx("inline-flex h-5 shrink-0 items-center rounded-full px-2 text-xs font-medium", STATE_TONE[c.state])}>{t(`hub.state.${c.state}`)}</span>
            ) : null}
          </div>
          {facts.length ? (
            <p className="text-ink-2 m-0 min-w-0 text-xs max-sm:line-clamp-2 sm:truncate" title={facts.join(" · ")}>
              {facts.join(" · ")}
            </p>
          ) : link.error ? null : (
            <p className="text-ink-2 m-0 text-xs">
              {link.connected ? t("hub.card.reading", { name: link.providerName }) : t("hub.card.notConnected", { name: link.providerName })}
            </p>
          )}
          {c && (c.checks || c.reviewers?.length || c.additions !== undefined || c.comments) ? (
            <p className="text-ink-2 m-0 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              {c.checks ? (
                <span className={cx("inline-flex items-center gap-1 font-medium", CHECK_TONE[c.checks])}>
                  {c.checks === "passing" ? (
                    <CheckIcon className="size-3" />
                  ) : c.checks === "failing" ? (
                    <span aria-hidden="true">✕</span>
                  ) : (
                    <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
                  )}
                  {t(`hub.checks.${c.checks}`)}
                </span>
              ) : null}
              {c.additions !== undefined || c.deletions !== undefined ? (
                <span className="tabular-nums" title={t("hub.card.lines")}>
                  <span className="text-ok">+{number(c.additions ?? 0)}</span> <span className="text-block">−{number(c.deletions ?? 0)}</span>
                </span>
              ) : null}
              {c.comments ? (
                <span className="inline-flex items-center gap-1 tabular-nums" title={t("hub.card.comments")}>
                  <ChatIcon className="size-3" />
                  {number(c.comments)}
                </span>
              ) : null}
              {c.reviewers?.map((r) => (
                <span key={r.name} className="inline-flex min-w-0 items-center gap-1" title={t(`hub.review.${r.state}`, { name: r.name })}>
                  <span
                    aria-hidden="true"
                    className={cx("size-1.5 shrink-0 rounded-full", r.state === "approved" ? "bg-ok-fill" : r.state === "changes" ? "bg-block" : "bg-edge")}
                  />
                  <span className="truncate">{r.name}</span>
                  <span className="sr-only">{t(`hub.review.${r.state}`, { name: r.name })}</span>
                </span>
              ))}
            </p>
          ) : null}
          {task}
          {link.error ? <p className="text-warn m-0 text-xs">{t("hub.card.stale", { why: link.error })}</p> : null}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {c?.embedUrl ? (
            <button
              type="button"
              className={iconBtn}
              aria-expanded={embed}
              aria-label={t(embed ? "hub.card.closeDesign" : "hub.card.openDesign")}
              title={t(embed ? "hub.card.closeDesign" : "hub.card.openDesign")}
              onClick={() => setEmbed((v) => !v)}
            >
              <ExpandIcon />
            </button>
          ) : null}
          {onRefresh && link.connected ? (
            <button type="button" className={iconBtn} disabled={busy} aria-label={t("hub.card.refresh")} title={t("hub.card.refresh")} onClick={onRefresh}>
              <RefreshIcon className={cx(busy && "motion-safe:animate-spin")} />
            </button>
          ) : null}
          {onRemove ? (
            <button type="button" className={iconBtn} disabled={busy} aria-label={t("hub.card.remove")} title={t("hub.card.remove")} onClick={onRemove}>
              <CloseIcon />
            </button>
          ) : null}
        </div>
      </div>
      {/* The design itself, from the tool's own viewer, only once asked for: nothing of it loads with the task. */}
      {embed && c?.embedUrl ? (
        <iframe src={c.embedUrl} title={c.title} loading="lazy" allowFullScreen className="border-hairline bg-ground aspect-video w-full rounded-lg border" />
      ) : null}
    </li>
  );
}

/** A design's preview, kept by the server (the browser never calls the design tool) and asked for apart from the list. */
function Thumbnail({ link, alt }: { link: WorkLink; alt: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let off = false;
    void api<{ dataUrl: string }>(`work/tasks/${link.taskId}/links/${link.id}/thumbnail`)
      .then((r) => !off && setSrc(r.dataUrl))
      .catch(() => undefined);
    return () => {
      off = true;
    };
  }, [link.taskId, link.id, link.cardAt]);
  return (
    <span className="bg-ground ring-hairline grid h-14 w-20 shrink-0 place-items-center overflow-hidden rounded-lg ring-1 ring-inset">
      {/* A data URL the server made: next/image has nothing to optimise. */}
      {src ? <img src={src} alt={alt} className="size-full object-cover" /> : <span className="shimmer size-full" aria-hidden="true" />}
    </span>
  );
}
