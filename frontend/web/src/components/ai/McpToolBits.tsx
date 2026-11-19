"use client";

import { useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n/client";
import { btn, btnPrimary, btnSm, cx, mono } from "@/lib/ui";
import Link from "next/link";
import {
  ApprovalIcon,
  CalendarIcon,
  ChatIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  FileIcon,
  FolderIcon,
  GlobeIcon,
  HashIcon,
  PaperclipIcon,
  SearchIcon,
  ShieldIcon,
  SparkleIcon,
  UsersIcon,
  VideoIcon,
  WorkflowIcon,
} from "@/components/app/icons";

import { Markdown } from "@/lib/markdown";
import { WORKSPACE_SERVER, type PendingCard, type Source, type ToolChip } from "./mention-types";

export type { PendingCard, Source, ToolChip } from "./mention-types";

const failed = (o: ToolChip["outcome"]) => o !== "ok" && o !== "declined";

/**
 * "Đã dùng GitHub · list_issues" above an answer: one compact line, opened to list each call with its outcome and
 * time. Loaded with the thread (assistant-ui's chunk), never with the page.
 */
export function ToolChips({ calls }: { calls: ToolChip[] }) {
  const t = useT();
  if (!calls.length) return null;
  const first = calls[0]!;
  const servers = [...new Set(calls.map((c) => c.server))];
  const bad = calls.filter((c) => failed(c.outcome)).length;
  // The app's own tools read as what was done ("Searched the workspace"); an outside system's as "Used GitHub · tool".
  const own = calls.every((c) => c.serverId === WORKSPACE_SERVER);
  const name = (c: ToolChip) => c.title || c.tool.replaceAll("_", " ");
  return (
    <details className="group/tools mb-2 max-w-full">
      <summary className="bg-hover text-ink-2 hover:text-ink inline-flex max-w-full cursor-pointer list-none items-center gap-1.5 rounded-full px-2.5 py-1 text-xs [&::-webkit-details-marker]:hidden">
        {own ? <SearchIcon className="size-3.5 shrink-0" /> : null}
        <span className="truncate">
          {own
            ? calls.length === 1
              ? name(first)
              : t("aiMention.steps", { count: calls.length, first: name(first) })
            : calls.length === 1
              ? t("mcpClient.chat.usedOne", { server: first.server, tool: first.tool })
              : t("mcpClient.chat.usedMany", { count: calls.length, servers: servers.join(", ") })}
        </span>
        {bad ? <span className="text-block shrink-0">· {t("mcpClient.chat.failedCount", { count: bad })}</span> : null}
        <ChevronDownIcon className="size-3.5 shrink-0 transition-transform group-open/tools:rotate-180" />
      </summary>
      <ul className="border-hairline m-0 mt-1.5 grid list-none gap-1 rounded-lg border p-2 text-xs">
        {calls.map((c, i) => (
          <li key={i} className="flex min-w-0 flex-wrap items-center gap-x-2">
            {c.serverId === WORKSPACE_SERVER ? (
              <span className="text-ink min-w-0 truncate">{name(c)}</span>
            ) : (
              <>
                <span className="text-ink font-medium">{c.server}</span>
                <span className={cx(mono, "text-ink-2 min-w-0 truncate")}>{c.tool}</span>
              </>
            )}
            <span className="flex-1" />
            <span className={failed(c.outcome) ? "text-block" : c.outcome === "declined" ? "text-ink-2" : "text-ok"}>{t(`mcpClient.outcome.${c.outcome}`)}</span>
            {c.outcome === "declined" ? null : <span className="text-ink-2 tabular-nums">{c.ms} ms</span>}
          </li>
        ))}
      </ul>
    </details>
  );
}

/** "dueAt" → "Due at", "assigneeId" → "Assignee id": an argument's name, for the card's details. */
const words = (key: string) => {
  const w = key
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase();
  return w.charAt(0).toUpperCase() + w.slice(1);
};

/**
 * What the AI wrote that the card does not already show, as readable lines: the arguments as JSON when they are not
 * an object, nothing when every value is shown above.
 */
function extraArgs(raw: string, shown: string[]): { key: string; value: string }[] | string {
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    // Cut short (a very long call): as written.
    return raw;
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return raw;
  const seen = shown.map((x) => x.trim());
  return Object.entries(o as Record<string, unknown>)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([key, v]) => ({ key, value: typeof v === "string" ? v : JSON.stringify(v) }))
    .filter((x) => !seen.some((s) => s && (s === x.value.trim() || s.startsWith(x.value.trim().slice(0, 200)))));
}

/**
 * A change the AI wants to make, waiting for the person's yes. The app's own actions say it in plain words ("Create a
 * task" with its title, assignee and due date) and keep what the AI wrote under Details; an outside system's tool
 * shows the system, the tool and its arguments.
 */
export function ConfirmCard({ card, onDecide }: { card: PendingCard; onDecide?: ((approve: boolean) => void | Promise<unknown>) | undefined }) {
  const t = useT();
  const raw = card.args && card.args !== "{}" ? card.args : "";
  const pv = card.preview;
  // Under Details: only what the AI wrote that the fields above do not already show (ids, options), never a blob.
  const extra =
    pv && raw
      ? extraArgs(
          raw,
          pv.fields.map((f) => f.value),
        )
      : [];
  // The choice just made: the card says it is being carried out (a change can take the AI a while to confirm). When
  // the decision fails the card stays, so its buttons come back.
  const [chosen, setChosen] = useState<boolean | null>(null);
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );
  const decide = (approve: boolean) => {
    setChosen(approve);
    void Promise.resolve(onDecide?.(approve))
      .catch(() => undefined)
      .then(() => live.current && setChosen(null));
  };
  return (
    <div role="group" aria-label={t("mcpClient.chat.confirmLabel")} className="border-hairline bg-surface shadow-card mt-2 grid min-w-0 gap-2.5 rounded-xl border p-3.5">
      {pv ? (
        <>
          <p className="m-0 flex min-w-0 items-start gap-2 text-sm">
            <ShieldIcon className="text-warn mt-0.5 size-4 shrink-0" />
            <span className="min-w-0">
              <span className="text-ink-2">{t("aiMention.wants")}</span> <span className="text-ink font-medium [overflow-wrap:anywhere]">{pv.title}</span>
            </span>
          </p>
          {pv.fields.length ? (
            <dl className="bg-hover/60 m-0 grid min-w-0 gap-x-3 gap-y-1.5 rounded-lg p-2.5 text-[13px] sm:grid-cols-[minmax(5rem,auto)_minmax(0,1fr)]">
              {pv.fields.map((f, i) => (
                <div key={i} className="contents">
                  <dt className="text-ink-2">{f.label}</dt>
                  {f.md ? (
                    <dd className="text-ink m-0 max-h-72 min-w-0 overflow-auto [overflow-wrap:anywhere] max-sm:mb-1 [&>:first-child]:mt-0 [&>:last-child]:mb-0">
                      <Markdown source={f.value} />
                    </dd>
                  ) : (
                    <dd className="text-ink m-0 min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere] max-sm:mb-1">{f.value}</dd>
                  )}
                </div>
              ))}
            </dl>
          ) : null}
          {pv.note ? <p className="text-ink-soft m-0 whitespace-pre-wrap text-[13px] [overflow-wrap:anywhere]">{pv.note}</p> : null}
          {extra.length ? (
            <details className="min-w-0">
              <summary className="text-ink-2 hover:text-ink w-fit cursor-pointer text-xs">{t("aiMention.details")}</summary>
              {typeof extra === "string" ? (
                <pre className={cx(mono, "bg-hover/60 text-ink-soft m-0 mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg p-2.5 text-xs [overflow-wrap:anywhere]")}>
                  {extra}
                </pre>
              ) : (
                <dl className="bg-hover/60 m-0 mt-1.5 grid min-w-0 gap-x-3 gap-y-1 rounded-lg p-2.5 text-xs sm:grid-cols-[minmax(5rem,auto)_minmax(0,1fr)]">
                  {extra.map((x) => (
                    <div key={x.key} className="contents">
                      <dt className="text-ink-2">{words(x.key)}</dt>
                      <dd className="text-ink-soft m-0 max-h-24 min-w-0 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] max-sm:mb-1">{x.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </details>
          ) : null}
          <p className="text-ink-2 m-0 text-xs">{t("aiMention.confirmHint")}</p>
        </>
      ) : (
        <>
          <p className="m-0 flex items-start gap-2 text-sm">
            <ShieldIcon className="text-warn mt-0.5 size-4 shrink-0" />
            <span className="min-w-0">
              {t("mcpClient.chat.confirm", { server: card.server })} <span className={cx(mono, "text-ink font-medium")}>{card.tool}</span>
              {card.title ? <span className="text-ink-2"> · {card.title}</span> : null}
            </span>
          </p>
          {raw ? (
            <pre className={cx(mono, "bg-hover/60 text-ink-soft m-0 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg p-2.5 text-xs [overflow-wrap:anywhere]")}>{raw}</pre>
          ) : null}
          <p className="text-ink-2 m-0 text-xs">{t("mcpClient.chat.confirmHint")}</p>
        </>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={cx(btnPrimary, btnSm)} disabled={!onDecide || chosen !== null} onClick={() => decide(true)}>
          {t(pv ? "aiMention.approve" : "mcpClient.chat.approve")}
        </button>
        <button type="button" className={cx(btn, btnSm)} disabled={!onDecide || chosen !== null} onClick={() => decide(false)}>
          {t(pv ? "aiMention.deny" : "mcpClient.chat.deny")}
        </button>
        {chosen !== null ? (
          <span role="status" className="text-ink-2 flex items-center gap-1.5 text-xs">
            <span className="bg-ink-2 size-1.5 animate-pulse rounded-full" aria-hidden="true" />
            {t(chosen ? "aiMention.doing" : "aiMention.cancelling")}
          </span>
        ) : null}
      </div>
    </div>
  );
}

const SOURCE_ICON: Record<Source["type"], React.ReactNode> = {
  message: <ChatIcon />,
  channel: <HashIcon />,
  task: <CheckCircleIcon />,
  document: <FileIcon />,
  project: <FolderIcon />,
  employee: <UsersIcon />,
  meeting: <VideoIcon />,
  event: <CalendarIcon />,
  file: <PaperclipIcon />,
  approval: <ApprovalIcon />,
  workflow: <WorkflowIcon />,
  web: <GlobeIcon />,
};
const SOURCES_SHOWN = 6;

/** An outside page as people read its address: the site, without "www.". */
export function siteOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
/** Only real web addresses are linked out; anything else a model wrote stays text. */
const outside = (x: Source) => x.type === "web" && /^https?:\/\//i.test(x.url);

/** What an answer read, as small links under it: the first six, the rest behind "+n". Only in-app paths are linked. */
export function SourceChips({ sources, className }: { sources: Source[] | undefined | null; className?: string }) {
  const t = useT();
  // The same item read twice (searched, then opened) is one source.
  const seen = new Set<string>();
  const list = (sources ?? []).filter((x) => x && x.title && !seen.has(`${x.type}:${x.id}`) && seen.add(`${x.type}:${x.id}`));
  if (!list.length) return null;
  const chip = (x: Source, i: number) => {
    const body = (
      <>
        <span className="text-ink-2 shrink-0 [&_svg]:size-3.5" aria-hidden="true">
          {SOURCE_ICON[x.type] ?? <SparkleIcon />}
        </span>
        <span className="min-w-0 truncate">{outside(x) ? siteOf(x.url) : x.title}</span>
      </>
    );
    const cls = "bg-surface ring-hairline text-ink-soft inline-flex h-6 min-w-0 max-w-[16rem] items-center gap-1.5 rounded-full px-2 text-xs ring-1 ring-inset max-md:h-7";
    // A web page opens in a new tab, never with this app as its referrer or opener.
    if (outside(x))
      return (
        <a
          key={i}
          href={x.url}
          target="_blank"
          rel="noopener noreferrer nofollow"
          title={`${x.title} · ${x.url}`}
          className={cx(cls, "hover:bg-hover hover:text-ink no-underline")}
        >
          {body}
        </a>
      );
    // A file's address redirects to storage: a plain link, never the app's router.
    if (x.type === "file" && typeof x.url === "string" && x.url.startsWith("/app/files/"))
      return (
        <a key={i} href={x.url} download title={x.title} className={cx(cls, "hover:bg-hover hover:text-ink no-underline")}>
          {body}
        </a>
      );
    return typeof x.url === "string" && x.url.startsWith("/") ? (
      <Link key={i} href={x.url} title={x.title} className={cx(cls, "hover:bg-hover hover:text-ink no-underline")}>
        {body}
      </Link>
    ) : (
      <span key={i} title={x.title} className={cls}>
        {body}
      </span>
    );
  };
  return (
    <div className={cx("mt-2 flex min-w-0 flex-wrap items-center gap-1.5", className)}>
      <span className="text-ink-2 text-xs">{t("aiMention.sources")}</span>
      {list.slice(0, SOURCES_SHOWN).map(chip)}
      {list.length > SOURCES_SHOWN ? (
        <details className="group/src contents">
          <summary className="bg-hover text-ink-2 hover:text-ink inline-flex h-6 cursor-pointer list-none items-center rounded-full px-2 text-xs group-open/src:hidden max-md:h-7 [&::-webkit-details-marker]:hidden">
            {t("aiMention.moreSources", { count: list.length - SOURCES_SHOWN })}
          </summary>
          {list.slice(SOURCES_SHOWN).map((x, i) => chip(x, i + SOURCES_SHOWN))}
        </details>
      ) : null}
    </div>
  );
}
