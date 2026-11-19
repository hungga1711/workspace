"use client";

import * as m from "motion/react-m";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/client";
import { formatMentions } from "@/lib/names";
import { useDirectory } from "@/lib/people";
import { useFormat, useT } from "@/lib/i18n/client";
import { btn, cx, iconBtn, skeleton } from "@/lib/ui";
import { useDialog } from "./useDialog";
import { HUE, iconTile, type Hue } from "@/lib/hue";
import { Portal } from "@/components/ui/Portal";
import {
  ApprovalIcon,
  AtIcon,
  BellIcon,
  BotIcon,
  CalendarIcon,
  ChatIcon,
  CheckCircleIcon,
  CheckIcon,
  ChevronRightIcon,
  ClockIcon,
  CloseIcon,
  FileIcon,
  FlagIcon,
  MegaphoneIcon,
  SettingsIcon,
  ShieldIcon,
} from "./icons";

interface Item {
  id: string;
  kind: string;
  title: string;
  body: string;
  url: string;
  readAt: string | null;
  createdAt: string;
  /** Who caused it (a person), when the server knows. */
  actorId?: string | null;
  /** Unread notices sharing it fold into one line ("8 approvals waiting"); see `groups`. */
  groupKey?: string | null;
  params?: Record<string, unknown>;
  /** The task or page it was about was deleted: no link. */
  gone?: boolean;
}
/** A burst the server folded: two or more unread notices with the same key. */
interface Group {
  key: string;
  kind: string;
  ids: string[];
  count: number;
  actorIds: string[];
  params: Record<string, unknown>;
}
interface Inbox {
  pinnedBrief: { title: string; body: string; url: string };
  action: Item[];
  updates: Item[];
  groups?: Group[];
  badge: number;
  fetchedAt: string;
}
/**
 * One row: identical notifications of a day (same kind, title and text) are said once, with how many there were; a
 * server group is one row whose own notices open underneath it.
 */
interface Row extends Item {
  ids: string[];
  count: number;
  unread: boolean;
  needsAction: boolean;
  group?: { key: string; items: Item[] };
}
type Tab = "all" | "action";
type Day = "today" | "yesterday" | "earlier";

const CACHE_KEY = "wos_inbox_cache";
const ICON: Record<string, (p: { className?: string }) => React.ReactNode> = {
  mention: AtIcon,
  "task.mention": AtIcon,
  "task.assigned": CheckCircleIcon,
  "task.completed": CheckCircleIcon,
  "task.commented": ChatIcon,
  "task.due": ClockIcon,
  // A task's agent asking before it acts (opens the temporary conversation).
  "task.agent_ask": BotIcon,
  // An agent's result waiting for this person's approval (same conversation).
  "task.agent_approval": ApprovalIcon,
  reminder: ClockIcon,
  "doc.updated": FileIcon,
  "doc.commented": ChatIcon,
  approval: ApprovalIcon,
  "approval.requested": ApprovalIcon,
  "approval.decided": ApprovalIcon,
  "approval.commented": ChatIcon,
  "leave.requested": ApprovalIcon,
  "leave.decided": ApprovalIcon,
  meeting: CalendarIcon,
  "meeting.invited": CalendarIcon,
  "meeting.updated": CalendarIcon,
  dm: ChatIcon,
  "decision.proposed": FlagIcon,
  "decision.decided": FlagIcon,
  "announcement.published": MegaphoneIcon,
  "ai.flagged": ShieldIcon,
  "ai.policy": ShieldIcon,
  "ai.extension": BotIcon,
  "ai.quota": BotIcon,
};
/** The kind's colour, the same one it has on Home and in search: tasks blue, people talking violet, requests green,
 * meetings orange, mentions and pages teal. */
const hueOf = (kind: string): Hue =>
  kind.includes("mention")
    ? "teal"
    : /comment|^dm$/.test(kind)
      ? "violet"
      : kind.startsWith("task") || kind === "reminder" || kind.startsWith("announcement")
        ? "blue"
        : /^(approval|leave|decision)/.test(kind)
          ? "green"
          : kind.startsWith("meeting")
            ? "orange"
            : kind.startsWith("doc")
              ? "teal"
              : kind.startsWith("ai")
                ? "violet"
                : "grey";
/** Sensitive data sent to an AI is the one notice that is a warning, not news: it gets the warning tone. */
const WARN = new Set(["ai.flagged"]);

const prefixOf = (s: string) => /^([^:\n]{2,24}):\s+\S/.exec(s)?.[1];
const dayKey = (iso: string) => new Date(iso).toLocaleDateString("en-CA");
function dayOf(iso: string, now: Date): Day {
  const d = dayKey(iso);
  if (d === dayKey(now.toISOString())) return "today";
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  return d === dayKey(y.toISOString()) ? "yesterday" : "earlier";
}

/**
 * Newest first, repeats of the same notice on the same day folded into one row, and each server group as one row at
 * the place of its newest notice (titled by `groupTitle`).
 */
function rowsOf(items: { item: Item; needsAction: boolean }[], groups: Group[], groupTitle: (g: Group) => string): Row[] {
  const sorted = [...items].sort((a, b) => Date.parse(b.item.createdAt) - Date.parse(a.item.createdAt));
  const out: Row[] = [];
  const at = new Map<string, Row>();
  const groupOf = new Map<string, Group>();
  for (const g of groups) for (const id of g.ids) groupOf.set(id, g);
  const grouped = new Map<string, Row>();
  for (const { item, needsAction } of sorted) {
    const g = groupOf.get(item.id);
    if (g) {
      const hit = grouped.get(g.key);
      if (hit) {
        hit.ids.push(item.id);
        hit.group!.items.push(item);
        hit.needsAction ||= needsAction;
        continue;
      }
      const row: Row = { ...item, title: groupTitle(g), body: "", ids: [item.id], count: 1, unread: true, needsAction, group: { key: g.key, items: [item] } };
      grouped.set(g.key, row);
      out.push(row);
      continue;
    }
    const key = `${dayKey(item.createdAt)}\u0000${item.kind}\u0000${item.title}\u0000${item.body}`;
    const hit = at.get(key);
    if (hit) {
      hit.ids.push(item.id);
      hit.count++;
      hit.unread ||= !item.readAt;
      hit.needsAction ||= needsAction;
      continue;
    }
    const row: Row = { ...item, ids: [item.id], count: 1, unread: !item.readAt, needsAction };
    at.set(key, row);
    out.push(row);
  }
  return out;
}

/**
 * The inbox under the bell: a 400px popover anchored to it on desktop, a full-screen sheet on phones. Header (title,
 * unread count, mark all read, notification settings, ×), two tabs (Tất cả · Cần xử lý), the pinned daily brief, then
 * rows grouped by day (Hôm nay · Hôm qua · Trước đó). Distinct loading, empty, offline and error states. Loaded on
 * demand (TopBar imports it with next/dynamic when the bell is first pressed).
 */
export default function NotificationPanel({ onClose, onBadge }: { onClose: () => void; onBadge: (n: number) => void }) {
  const dir = useDirectory();
  const names = dir.names;
  const t = useT();
  const { ago } = useFormat();
  const ref = useDialog<HTMLDivElement>(onClose);
  const [data, setData] = useState<Inbox | null>(null);
  const [error, setError] = useState(false);
  const [stale, setStale] = useState(false);
  const [tab, setTab] = useState<Tab>("all");

  const load = () => {
    setError(false);
    api<Inbox>("home/notifications")
      .then((d) => {
        setData(d);
        setStale(false);
        onBadge(d.badge);
        try {
          sessionStorage.setItem(CACHE_KEY, JSON.stringify(d));
        } catch {
          /* storage unavailable */
        }
      })
      .catch(() => {
        setError(true);
        try {
          const c = sessionStorage.getItem(CACHE_KEY);
          if (c) {
            setData(JSON.parse(c) as Inbox);
            setStale(true);
          }
        } catch {
          /* ignore */
        }
      });
  };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  const readAll = async () => {
    await api("home/notifications/read-all", { method: "POST" });
    onBadge(0);
    load();
  };
  const open = (ids: string[]) => {
    for (const id of ids) void api(`home/notifications/${id}/read`, { method: "POST" });
    onClose();
  };
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const readGroup = async (key: string) => {
    await api("home/notifications/read-group", { method: "POST", body: JSON.stringify({ key }) }).catch(() => undefined);
    load();
  };

  // "Lily", "Lily and Tom", "Lily and 3 others": the people behind a group, named from the directory.
  const who = (ids: string[]) => {
    const [a, b] = ids.map((id) => dir.short(id));
    if (!a) return "";
    if (ids.length === 1) return a;
    if (ids.length === 2) return t("inbox.who.two", { a, b });
    return t("inbox.who.many", { a, count: ids.length - 1 });
  };
  const groupTitle = (g: Group) => {
    const count = g.count;
    const code = String(g.params.code ?? "");
    const title = String(g.params.title ?? "");
    switch (g.kind) {
      case "approval.requested":
        return t("inbox.group.approvals", { count });
      case "leave.requested":
        return t("inbox.group.leave", { count });
      case "task.assigned":
        return t("inbox.group.assigned", { count });
      case "ai.flagged":
        return t("inbox.group.flagged", { count });
      case "task.due":
        return t("inbox.group.dueSoon", { count });
      case "meeting.invited":
        return t("inbox.group.meetings", { count });
      case "task.commented":
        return g.actorIds.length ? t("inbox.group.commented", { who: who(g.actorIds), code }) : t("inbox.group.comments", { count, code });
      case "doc.commented":
        return g.actorIds.length ? t("inbox.group.docCommented", { who: who(g.actorIds), title }) : t("inbox.group.docComments", { count, title });
      case "task.mention":
        return t("inbox.group.taskMentions", { count, code });
      case "mention":
        return g.params.channel ? t("inbox.group.mentions", { count, channel: String(g.params.channel) }) : t("inbox.group.mentionsDm", { count });
      default:
        return t("inbox.times", { count });
    }
  };

  const rows = useMemo(() => {
    if (!data) return { all: [] as Row[], action: [] as Row[] };
    const action = data.action.map((item) => ({ item, needsAction: true }));
    const groups = data.groups ?? [];
    return {
      all: rowsOf([...action, ...data.updates.map((item) => ({ item, needsAction: false }))], groups, groupTitle),
      action: rowsOf(action, groups, groupTitle),
    };
  }, [data, dir]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = rows[tab];
  const unread = data?.badge ?? 0;
  const actionCount = rows.action.length;

  const groups = useMemo(() => {
    const now = new Date();
    const out: { day: Day; rows: Row[] }[] = [];
    for (const r of shown) {
      const day = dayOf(r.createdAt, now);
      const last = out[out.length - 1];
      if (last?.day === day) last.rows.push(r);
      else out.push({ day, rows: [r] });
    }
    return out;
  }, [shown]);

  // "Cần duyệt: Đề xuất…", "Cần duyệt: Thanh toán…": a prefix that repeats in the list is said once per row, quietly,
  // next to the time, so each row leads with what it is about.
  const repeated = useMemo(() => {
    const seen = new Map<string, number>();
    for (const r of shown) {
      const p = prefixOf(r.title);
      if (p) seen.set(p, (seen.get(p) ?? 0) + 1);
    }
    return new Set([...seen].filter(([, n]) => n > 1).map(([p]) => p));
  }, [shown]);

  const row = (r: Row) => {
    const Icon = ICON[r.kind] ?? BellIcon;
    const warn = WARN.has(r.kind);
    const prefix = r.group ? undefined : prefixOf(r.title);
    const label = prefix && repeated.has(prefix) ? prefix : null;
    const title = label ? r.title.slice(label.length + 1).trimStart() : r.title;
    const open_ = r.group ? expanded.has(r.group.key) : false;
    const inner = (
      <>
        <span className={cx(iconTile, "mt-0.5 size-8", HUE[warn ? "orange" : hueOf(r.kind)])}>
          <Icon />
        </span>
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className={cx("line-clamp-2 text-[13px] leading-snug", r.unread ? "text-ink font-medium" : "text-ink-2")}>{formatMentions(title, names)}</span>
          {r.gone ? (
            <span className="text-ink-2 truncate text-xs italic">{t("inbox.gone")}</span>
          ) : r.body ? (
            <span className="text-ink-2 truncate text-xs">{formatMentions(r.body, names)}</span>
          ) : null}
          <span className="text-ink-2 flex items-center gap-1.5 text-xs">
            <time dateTime={r.createdAt}>{ago(r.createdAt)}</time>
            {r.count > 1 ? (
              <>
                <span aria-hidden="true">·</span>
                <span className="tabular-nums">{t("inbox.times", { count: r.count })}</span>
              </>
            ) : null}
            {r.group ? (
              <>
                <span aria-hidden="true">·</span>
                <span className="text-accent-text font-medium">{open_ ? t("inbox.hide") : t("inbox.showAll")}</span>
              </>
            ) : label || (r.needsAction && tab === "all") ? (
              <>
                <span aria-hidden="true">·</span>
                <span className={cx("truncate", r.needsAction ? "text-accent-text font-medium" : undefined)}>{label ?? t("inbox.action")}</span>
              </>
            ) : null}
          </span>
        </span>
        {r.unread ? <span className="bg-signal mt-2 size-2 shrink-0 rounded-full" role="img" aria-label={t("inbox.unread")} /> : <span className="size-2 shrink-0" />}
      </>
    );
    const rowCls = "hover:bg-hover focus-visible:bg-hover group/row flex w-full gap-3 rounded-xl px-3 py-2.5 text-left no-underline focus-visible:outline-offset-[-2px]";
    if (r.group) {
      const g = r.group;
      return (
        <li key={g.key}>
          <div className="flex items-start">
            <button type="button" className={rowCls} aria-expanded={open_} onClick={() => toggle(g.key)}>
              {inner}
            </button>
          </div>
          {open_ ? (
            <div className="border-divider mb-1 ml-7 grid gap-0.5 border-l pl-2">
              {g.items.map((it) =>
                it.gone ? (
                  <div key={it.id} className="grid gap-0.5 px-3 py-2">
                    <span className="text-ink-2 line-clamp-2 text-[13px]">{formatMentions(it.title, names)}</span>
                    <span className="text-ink-2 text-xs italic">{t("inbox.gone")}</span>
                  </div>
                ) : (
                  <Link key={it.id} href={it.url} onClick={() => open([it.id])} className="hover:bg-hover grid gap-0.5 rounded-lg px-3 py-2 no-underline">
                    <span className="text-ink line-clamp-2 text-[13px]">{formatMentions(it.title, names)}</span>
                    {it.body ? <span className="text-ink-2 truncate text-xs">{formatMentions(it.body, names)}</span> : null}
                    <time dateTime={it.createdAt} className="text-ink-2 text-xs">
                      {ago(it.createdAt)}
                    </time>
                  </Link>
                ),
              )}
              <button type="button" className="text-accent-text hover:bg-hover justify-self-start rounded-lg px-3 py-1.5 text-xs font-medium" onClick={() => void readGroup(g.key)}>
                {t("inbox.markGroupRead")}
              </button>
            </div>
          ) : null}
        </li>
      );
    }
    if (r.gone || !r.url)
      return (
        <li key={r.ids.join(",")}>
          <div className={cx(rowCls, "hover:bg-transparent")}>{inner}</div>
        </li>
      );
    return (
      <li key={r.ids.join(",")}>
        <Link href={r.url} onClick={() => open(r.ids)} className={rowCls}>
          {inner}
        </Link>
      </li>
    );
  };

  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: "all", label: t("inbox.all") },
    { key: "action", label: t("inbox.action"), count: actionCount || undefined },
  ];

  return (
    <Portal>
      {/* Desktop: no scrim, a click anywhere outside closes it. Phones: the sheet is the screen. */}
      <div className="fixed inset-0 z-[70]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <m.div
          ref={ref}
          role="dialog"
          aria-modal="true"
          aria-labelledby="inbox-title"
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.16, ease: [0.2, 0.7, 0.2, 1] }}
          className="bg-surface md:border-hairline md:shadow-popover fixed inset-0 flex flex-col overflow-hidden md:inset-auto md:right-3 md:top-[54px] md:max-h-[min(640px,calc(100dvh-70px))] md:w-[400px] md:rounded-lg md:border"
        >
          <header className="flex min-h-14 shrink-0 items-center gap-1 pl-4 pr-2 md:min-h-12">
            <h2 id="inbox-title" className="text-ink m-0 flex flex-1 items-center gap-2 text-[14px] font-semibold">
              {t("inbox.title")}
              {unread > 0 ? <span className="text-ink-2 text-xs font-normal tabular-nums">{t("inbox.unreadCount", { count: unread })}</span> : null}
            </h2>
            {unread > 0 ? (
              <button type="button" className={iconBtn} onClick={() => void readAll()} aria-label={t("inbox.readAll")} title={t("inbox.readAll")}>
                <CheckIcon />
              </button>
            ) : null}
            <Link href="/app/me?tab=notify" onClick={onClose} className={iconBtn} aria-label={t("inbox.settings")} title={t("inbox.settings")}>
              <SettingsIcon />
            </Link>
            <button type="button" className={iconBtn} onClick={onClose} aria-label={t("common.close")} title={t("common.close")}>
              <CloseIcon />
            </button>
          </header>

          <div role="tablist" aria-label={t("inbox.title")} className="border-divider flex shrink-0 gap-4 border-b px-4">
            {tabs.map((x) => (
              <button
                key={x.key}
                type="button"
                role="tab"
                aria-selected={tab === x.key}
                onClick={() => setTab(x.key)}
                className={cx(
                  "-mb-px flex min-h-9 items-center gap-1.5 border-b-2 text-[13px] transition-colors",
                  tab === x.key ? "border-ink text-ink font-semibold" : "text-ink-2 hover:text-ink border-transparent",
                )}
              >
                {x.label}
                {x.count ? <span className="bg-hover text-ink-2 rounded-sm px-1.5 text-xs font-semibold tabular-nums">{x.count}</span> : null}
              </button>
            ))}
          </div>

          <div role="tabpanel" className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-2">
            {!data && !error ? (
              <div aria-busy="true" className="grid gap-4 p-4">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="flex items-start gap-3">
                    <span className="bg-hover size-8 shrink-0 animate-pulse rounded-full" />
                    <span className="grid flex-1 gap-2">
                      <span className={cx(skeleton, "w-4/5")} />
                      <span className={cx(skeleton, "w-2/5")} />
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
            {error && !data ? (
              <div className="grid justify-items-center gap-2 px-6 py-10 text-center" role="alert">
                <p className="text-ink m-0 text-sm font-medium">{t("inbox.loadError")}</p>
                <button type="button" className={btn} onClick={load}>
                  {t("common.retry")}
                </button>
              </div>
            ) : null}
            {data ? (
              <>
                {stale ? <p className="bg-warn-wash text-warn mx-3 mt-3 rounded-lg px-3 py-2 text-xs">{t("inbox.stale")}</p> : null}
                {tab === "all" ? (
                  <Link
                    href={data.pinnedBrief.url}
                    onClick={onClose}
                    className="border-hairline hover:bg-hover mx-3 mt-3 flex items-center gap-3 rounded-lg border px-3 py-2.5 no-underline"
                  >
                    {/* The day's brief is counts, not AI: a calendar, not the AI mark. */}
                    <span className={cx(iconTile, "size-8", HUE.blue)}>
                      <CalendarIcon />
                    </span>
                    <span className="grid min-w-0 flex-1">
                      <span className="text-ink text-[13px] font-semibold">{data.pinnedBrief.title}</span>
                      <span className="text-ink-2 truncate text-xs">{data.pinnedBrief.body}</span>
                    </span>
                    <ChevronRightIcon className="text-ink-2 size-4 shrink-0" />
                  </Link>
                ) : null}
                {shown.length === 0 ? (
                  <div className="grid justify-items-center gap-1.5 px-6 py-12 text-center">
                    <span className="bg-ground text-ink-2 mb-1 grid size-10 place-items-center rounded-full">
                      {tab === "action" ? <CheckCircleIcon className="size-5" /> : <BellIcon className="size-5" />}
                    </span>
                    <p className="text-ink m-0 text-sm font-medium">{tab === "action" ? t("inbox.emptyAction") : t("inbox.emptyAll")}</p>
                    <p className="text-ink-2 m-0 text-xs">{tab === "action" ? t("inbox.emptyActionHint") : t("inbox.emptyAllHint")}</p>
                  </div>
                ) : (
                  groups.map((g) => (
                    <section key={g.day} aria-label={t(`inbox.${g.day}`)} className="px-1 pt-2">
                      <h3 className="text-ink-2 m-0 px-3 pb-1 pt-2 text-xs font-medium">{t(`inbox.${g.day}`)}</h3>
                      <ul className="m-0 grid list-none gap-0.5 p-0 px-1">{g.rows.map(row)}</ul>
                    </section>
                  ))
                )}
              </>
            ) : null}
          </div>
        </m.div>
      </div>
    </Portal>
  );
}
