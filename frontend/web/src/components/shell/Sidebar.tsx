"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useT } from "@/lib/i18n/client";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Avatar, useDirectory } from "@/lib/people";
import { api } from "@/lib/client";
import { cx, navActive, navIcon, navIdle, navItem } from "@/lib/ui";
import {
  ApprovalIcon,
  BellOffIcon,
  BoardIcon,
  CalendarIcon,
  ClockIcon,
  FileIcon,
  HomeIcon,
  LockIcon,
  PlusIcon,
  SettingsIcon,
  SparkleIcon,
  WhiteboardIcon,
} from "@/components/app/icons";
import type { ChannelSummary, ShellUser } from "./types";
import { WorkspaceLogo } from "./WorkspaceHeader";
import { StatusBadge } from "@/components/app/Status";
import { channelTitle } from "@/components/home/channelTitle";
import { TASK_TABS, workTabOf } from "@/components/work/workTabAlias";
import { useLiveChannels } from "@/components/chat/useLiveChannels";
import { AskNav } from "./AskNav";
import { useFeature, useFeatures } from "@/lib/features-context";
import { useIntentPrefetch } from "@/lib/intent-prefetch";
import { navTarget } from "./navTarget";

// Dialogs load when opened, not with every page.
const NewChannelModal = dynamic(() => import("@/components/chat/NewConversation").then((m) => m.NewChannelModal), { ssr: false });
const NewDmModal = dynamic(() => import("@/components/chat/NewConversation").then((m) => m.NewDmModal), { ssr: false });

/**
 * The eight destinations: Trang chủ, Việc (with the goals), AI, Work's other four areas, then Chấm công. Conversations are not a destination: channels and direct messages are listed below (the "N chưa đọc" header opens the unread view), and the
 * phone's bottom bar has "Tin nhắn". Work's areas are tabs at /app/work/<tab> (`tabs`: the keys that light them).
 */
const NAV = [
  { href: "/app/home", label: "shell.nav.home", Icon: HomeIcon, tabs: null, feature: null },
  { href: "/app/work/tasks", label: "shell.nav.tasks", Icon: BoardIcon, tabs: TASK_TABS, feature: null },
  // AI: Tiến độ, Hỏi đáp, Áp dụng AI (/app/ai/*).
  { href: "/app/ai", label: "shell.nav.aiHub", Icon: SparkleIcon, tabs: null, feature: "ai" },
  { href: "/app/work/docs", label: "shell.nav.docs", Icon: FileIcon, tabs: ["docs"], feature: "docs" },
  { href: "/app/work/whiteboards", label: "shell.nav.whiteboards", Icon: WhiteboardIcon, tabs: ["whiteboards"], feature: "whiteboards" },
  { href: "/app/work/calendar", label: "shell.nav.calendar", Icon: CalendarIcon, tabs: ["calendar"], feature: "calendar" },
  { href: "/app/work/ops", label: "shell.nav.requests", Icon: ApprovalIcon, tabs: ["ops"], feature: null },
  // Chấm công: clock-in, attendance, leave; the profile moved to the avatar in the top bar.
  { href: "/app/time", label: "shell.nav.time", Icon: ClockIcon, tabs: null, feature: "time" },
] as const;

/** AI Insights only (Admin › Settings › Workspace mode): Home and AI; tasks arrive from the team's own tool. */
const INSIGHTS_NAV = new Set<string>(["/app/home", "/app/ai"]);

/** Pages inside Work that belong to a destination (a task or project → Việc, a doc → Tài liệu, …). */
function destinationOf(path: string): string | null {
  if (path.startsWith("/app/work/docs")) return "docs";
  if (path.startsWith("/app/work/whiteboards")) return "whiteboards";
  if (path.startsWith("/app/work/meetings")) return "calendar";
  if (path.startsWith("/app/work/approvals")) return "ops";
  if (path.startsWith("/app/work/")) return "tasks";
  return null;
}

/** A channel's mark: a plain muted "#" in the avatar's 24px column (no coloured tile: colour is for people and status). */
const tile = "grid w-6 shrink-0 place-items-center text-[15px] font-medium text-ink-2";
/** Section rows (channels, people): 32px rows like the destinations, quieter in colour. */
const subItem = "relative flex min-h-8 items-center gap-2.5 rounded-md px-2 text-sm no-underline transition-colors duration-100 max-md:min-h-10";

/**
 * Desktop sidebar on the grey ground: the workspace switcher (it opens the account menu), the
 * destinations as pills (here = a raised white pill), then "Kênh" (its header counts unread channels and opens the
 * unread view) and "Tin nhắn" (avatars with a presence dot); "Quản trị" at the foot for admins. Projects are not
 * listed here: Việc already has them (one list, one place).
 * Tablets (768–1023 px) get a 64 px icon rail: destinations only, labels kept as accessible names and tooltips.
 * Unread is a quiet count and an unread conversation's name is semibold ink; a mention is one blue dot.
 */
export function Sidebar({
  workspace,
  logoColor,
  logoUrl,
  channels: rendered,
  memberCount,
  user,
  insightsOnly = false,
}: {
  workspace: string;
  /** The workspace's own colour, or null for the standard mark. */
  logoColor: string | null;
  /** The uploaded logo (Admin › Cài đặt), shown instead of the colour tile. */
  logoUrl?: string | null;
  channels: ChannelSummary[];
  memberCount: number;
  user: ShellUser;
  /** AI Insights only: the short navigation, no channels or direct messages. */
  insightsOnly?: boolean;
}) {
  const path = usePathname();
  const dir = useDirectory();
  const t = useT();
  const hasAi = useFeature("ai");
  const channels = useLiveChannels(rendered, user.userId);
  const [modal, setModal] = useState<"channel" | "dm" | null>(null);
  const rooms = channels.filter((c) => c.kind === "public" || c.kind === "private");
  // A brand-new workspace gets its channels from an event a second or two after signup:
  // refresh the shell a few times instead of showing an empty list until the next full load.
  const router = useRouter();
  const [waited, setWaited] = useState(0);
  useEffect(() => {
    if (insightsOnly || rooms.length > 0 || waited >= 10) return;
    const t = setTimeout(() => {
      router.refresh();
      setWaited((n) => n + 1);
    }, 1500);
    return () => clearTimeout(t);
  }, [insightsOnly, rooms.length, waited, router]);
  // Direct messages: most recent conversation first, like any messenger.
  const dms = channels.filter((c) => c.kind === "dm" || c.kind === "group").sort((a, b) => Date.parse(b.lastMessageAt ?? "0") - Date.parse(a.lastMessageAt ?? "0"));
  const starred = channels.filter((c) => c.starred);
  // Channels with something unread (muted ones excluded): the "Kênh" header's "N chưa đọc".
  const unreadRooms = rooms.filter((c) => c.unread > 0 && !c.muted).length;
  const presence = usePresence(dms.flatMap((c) => (c.kind === "dm" && c.dmUserId ? [c.dmUserId] : [])));
  const openDm = async (userId: string) => {
    const r = await api<{ id: string }>("chat/dms", { method: "POST", body: { userId } }).catch(() => null);
    if (r) {
      router.push(`/app/chat/${r.id}`);
      router.refresh();
    }
  };
  // "(3) Home · workspace": mentions plus unread direct messages, muted conversations excluded.
  const attention = channels.reduce((n, c) => n + (c.muted ? 0 : c.kind === "dm" || c.kind === "group" ? c.unread : c.mentions), 0);
  useEffect(() => {
    const apply = () => {
      const base = document.title.replace(/^\(\d+\+?\) /, "");
      const next = attention > 0 ? `(${attention > 99 ? "99+" : attention}) ${base}` : base;
      if (document.title !== next) document.title = next;
    };
    // Next sets the page title after navigation; apply once now and once after that settles.
    apply();
    const t = setTimeout(apply, 150);
    return () => clearTimeout(t);
  }, [attention, path]);
  const [open, setOpen] = useState({ starred: true, rooms: true, dms: true });
  useEffect(() => {
    try {
      const v = localStorage.getItem("wos_sidebar_groups");
      if (v) setOpen((o) => ({ ...o, ...JSON.parse(v) }));
    } catch {
      /* private mode */
    }
  }, []);
  const toggle = (k: keyof typeof open) =>
    setOpen((o) => {
      const n = { ...o, [k]: !o[k] };
      try {
        localStorage.setItem("wos_sidebar_groups", JSON.stringify(n));
      } catch {
        /* ignore */
      }
      return n;
    });

  const row = (c: ChannelSummary) => {
    const href = `/app/chat/${c.id}`;
    const active = path === href;
    const dm = c.kind === "dm";
    const unread = c.unread > 0 && !c.muted;
    return (
      <Link
        key={c.id}
        href={href}
        // No prefetch: each conversation link would render that channel on the server on every page view (dozens of
        // module calls for a long sidebar); a conversation opens fast enough on click.
        prefetch={false}
        aria-current={active ? "page" : undefined}
        className={cx(subItem, active ? navActive : unread ? "text-ink hover:bg-hover font-semibold" : navIdle, c.muted && !active && "opacity-60")}
      >
        {dm ? (
          <Avatar id={c.dmUserId ?? ""} size="sm" online={presence[c.dmUserId ?? ""]} className="[&>span]:ring-frame" />
        ) : (
          <span aria-hidden="true" className={tile}>
            {c.kind === "private" ? <LockIcon className="size-3.5" /> : "#"}
          </span>
        )}
        <span className="flex-1 truncate">{dm ? dir.name(c.dmUserId ?? "") : channelTitle(c)}</span>
        {dm && presence[c.dmUserId ?? ""] ? <span className="sr-only">{t("shell.nav.online")}</span> : null}
        {dm && c.dmUserId ? <StatusBadge userId={c.dmUserId} /> : null}
        {c.muted ? <BellOffIcon className="size-3.5 shrink-0" /> : null}
        <Signal c={c} />
      </Link>
    );
  };
  // The rail (tablets) keeps only the destinations: icon-only, centred.
  const item = (active: boolean) => cx(navItem, "max-lg:justify-center max-lg:px-0", active ? navActive : navIdle);

  return (
    <aside
      // Flush to the window, a step off white, one hairline from the content (no floating panels).
      className="bg-frame border-hairline hidden w-14 shrink-0 flex-col border-r md:sticky md:top-0 md:flex md:h-dvh md:self-start lg:w-[232px] print:!hidden"
      aria-label={t("shell.nav.sidebar")}
    >
      <div className="flex h-12 items-center px-2">
        {/* The company's name only: everything about me is the avatar's menu, the people and admin too. */}
        <div className="flex h-8 w-full items-center gap-2 px-1.5 max-lg:justify-center max-lg:px-0">
          <WorkspaceLogo name={workspace} color={logoColor} logoUrl={logoUrl} className="size-5 rounded-[5px] text-[11px]" />
          <span className="text-ink min-w-0 flex-1 truncate text-sm font-semibold max-lg:hidden" title={`${workspace} · ${t("shell.nav.members", { count: memberCount })}`}>
            {workspace}
          </span>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        <MainNav item={item} path={path} insightsOnly={insightsOnly} />

        <div className={cx("max-lg:hidden", insightsOnly && "hidden")}>
          {/* Temporary items while a task's agent waits for answers (not channels; gone once answered). */}
          {hasAi ? <AskNav path={path} itemClass={subItem} groupClass="text-ink-2 m-0 flex min-h-8 items-end px-2 pb-1 text-xs font-medium" /> : null}
          {starred.length ? (
            <>
              <Group title={t("shell.nav.starred")} open={open.starred} onToggle={() => toggle("starred")} />
              {open.starred ? starred.map(row) : null}
            </>
          ) : null}

          <Group
            title={t("shell.nav.channels")}
            open={open.rooms}
            onToggle={() => toggle("rooms")}
            onAdd={() => setModal("channel")}
            addLabel={t("shell.nav.createChannel")}
            aside={
              unreadRooms > 0 ? (
                <Link href="/app/chat/unreads" className="text-ink-2 hover:text-ink rounded-sm px-1 text-xs font-medium no-underline hover:underline">
                  {t("shell.nav.unreadHeader", { count: unreadRooms })}
                </Link>
              ) : null
            }
          />
          {open.rooms ? rooms.filter((c) => !c.starred).map(row) : rooms.filter((c) => !c.starred && (c.unread > 0 || path === `/app/chat/${c.id}`)).map(row)}
          {rooms.length === 0 ? (
            <p className="text-ink-2 px-3 py-1 text-sm" aria-live="polite">
              {waited < 10 ? t("shell.nav.preparingChannels") : t("shell.nav.noChannels")}
            </p>
          ) : null}
          {open.rooms && rooms.length > 0 ? (
            <Link href="/app/chat/browse" className={cx(subItem, "text-ink-2 hover:bg-hover hover:text-ink")}>
              <span className="grid w-4 shrink-0 place-items-center" aria-hidden="true">
                <PlusIcon className="size-3.5" />
              </span>
              {t("shell.nav.addChannel")}
            </Link>
          ) : null}

          <Group title={t("shell.nav.dms")} open={open.dms} onToggle={() => toggle("dms")} onAdd={() => setModal("dm")} addLabel={t("shell.nav.newMessage")} />
          {open.dms ? dms.filter((c) => !c.starred).map(row) : dms.filter((c) => !c.starred && c.unread > 0).map(row)}
          {dms.length === 0 ? (
            <>
              {/* No direct messages yet: offer the first few colleagues, one click opens the conversation. */}
              {dir.people
                .filter((p) => p.userId !== dir.me)
                .slice(0, 4)
                .map((p) => (
                  <button
                    key={p.userId}
                    type="button"
                    onClick={() => void openDm(p.userId)}
                    className={cx(subItem, navIdle, "w-full text-left")}
                    aria-label={t("shell.nav.dmWith", { name: p.displayName })}
                  >
                    <Avatar id={p.userId} size="sm" />
                    <span className="truncate">{p.displayName}</span>
                  </button>
                ))}
              <button type="button" onClick={() => setModal("dm")} className={cx(subItem, "text-ink-2 hover:bg-hover hover:text-ink w-full text-left")}>
                <span className="grid w-4 shrink-0 place-items-center" aria-hidden="true">
                  <PlusIcon className="size-3.5" />
                </span>
                <span className="truncate">{t("shell.nav.dmColleague")}</span>
              </button>
            </>
          ) : null}
        </div>
      </div>
      {user.isAdmin ? (
        <div className="border-hairline border-t px-2 py-2">
          <Link href="/admin/workspace" className={item(false)} title={t("shell.nav.admin")}>
            <SettingsIcon />
            <span className="flex-1 truncate max-lg:sr-only">{t("shell.nav.admin")}</span>
          </Link>
        </div>
      ) : null}
      {modal === "channel" ? <NewChannelModal onClose={() => setModal(null)} /> : null}
      {modal === "dm" ? <NewDmModal onClose={() => setModal(null)} /> : null}
    </aside>
  );
}

/**
 * Who of the people I message is online, for the dot on their avatar: asked once the page is idle and again every
 * two minutes while the tab is visible (one small request; nothing when there are no direct messages).
 */
function usePresence(ids: string[]): Record<string, boolean> {
  const key = [...new Set(ids)].sort().slice(0, 50).join(",");
  const [online, setOnline] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (!key) return;
    let stop = false;
    const load = () => {
      if (document.visibilityState !== "visible") return;
      void api<{ presence: Record<string, boolean> | { userId: string; online: boolean }[] }>(`chat/presence?userIds=${key}`)
        .then((r) => {
          if (!stop) setOnline(Array.isArray(r.presence) ? Object.fromEntries(r.presence.map((x) => [x.userId, x.online])) : r.presence);
        })
        .catch(() => undefined);
    };
    const idle = typeof requestIdleCallback === "function" ? requestIdleCallback(load, { timeout: 4000 }) : (setTimeout(load, 1500) as unknown as number);
    const every = setInterval(load, 120_000);
    return () => {
      stop = true;
      if (typeof cancelIdleCallback === "function") cancelIdleCallback(idle);
      clearInterval(every);
    };
  }, [key]);
  return online;
}

function Group({
  title,
  open,
  onToggle,
  onAdd,
  addLabel,
  aside,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  onAdd?: () => void;
  addLabel?: string;
  aside?: React.ReactNode;
}) {
  return (
    <div className="group/g flex min-h-8 items-end gap-1 pb-1 pl-2 pr-1">
      <button type="button" onClick={onToggle} aria-expanded={open} className="text-ink-2 hover:text-ink -ml-1 flex-1 rounded-sm px-1 text-left text-xs font-medium">
        {title}
      </button>
      {onAdd ? (
        <button
          type="button"
          onClick={onAdd}
          aria-label={addLabel}
          title={addLabel}
          className="text-ink-2 hover:bg-hover hover:text-ink -my-1 grid size-6 place-items-center rounded-md opacity-0 transition-opacity focus-visible:opacity-100 group-hover/g:opacity-100"
        >
          <PlusIcon className="size-3.5" />
        </button>
      ) : null}
      {aside}
    </div>
  );
}

/** A quiet count; a blue dot when someone mentioned you. */
function Signal({ c }: { c: ChannelSummary }) {
  const t = useT();
  if (c.mentions > 0)
    return (
      <>
        <span className="text-accent-text text-xs font-semibold tabular-nums" aria-hidden="true">
          {c.mentions > 99 ? "99+" : c.mentions}
        </span>
        <span className="bg-signal size-2 shrink-0 rounded-full" aria-hidden="true" />
        <span className="sr-only">{t("shell.nav.mentionCount", { count: c.mentions })}</span>
      </>
    );
  if (c.unread > 0 && !c.muted)
    return (
      <>
        <span className="text-ink-2 text-xs font-normal tabular-nums" aria-hidden="true">
          {c.unread > 99 ? "99+" : c.unread}
        </span>
        <span className="sr-only">{t("shell.nav.unreadCount", { count: c.unread })}</span>
      </>
    );
  return null;
}

type ItemClass = (active: boolean) => string;
type NavProps = { item: ItemClass; path: string; insightsOnly?: boolean };

/** The main list; Work's active area comes from the address (/app/work/calendar, a task, a doc…). */
function MainNav({ item, path, insightsOnly = false }: NavProps) {
  const t = useT();
  const has = useFeatures();
  const area = path === "/app/work" ? "tasks" : (workTabOf(path) ?? destinationOf(path));
  const intent = useIntentPrefetch();
  return (
    <nav className="grid gap-0.5 pt-1" aria-label={t("shell.nav.main")}>
      {/* A destination the deployment left out (DISABLED_FEATURES) is not listed. */}
      {(insightsOnly ? NAV.filter((n) => INSIGHTS_NAV.has(n.href)) : NAV.filter((n) => has(n.feature))).map(({ href, label, Icon, tabs }) => {
        const active = tabs ? area !== null && (tabs as readonly string[]).includes(area) : path.startsWith(href);
        return (
          <Link
            key={href}
            href={navTarget(href)}
            aria-current={active ? "page" : undefined}
            prefetch={href === "/app/home"}
            {...(href === "/app/home" ? {} : intent(navTarget(href)))}
            className={item(active)}
            title={t(label)}
          >
            <Icon className={navIcon(active)} />
            <span className="flex-1 truncate max-lg:sr-only">{t(label)}</span>
          </Link>
        );
      })}
    </nav>
  );
}
