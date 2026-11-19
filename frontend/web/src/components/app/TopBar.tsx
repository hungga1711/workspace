"use client";

import { openMeeting } from "@/components/meet/open";
import { ConnectionBanner } from "@/components/shell/ConnectionBanner";
import { HistoryNav } from "@/components/shell/HistoryNav";
import dynamic from "next/dynamic";
import { usePathname, useRouter, useSelectedLayoutSegment } from "next/navigation";
import { api } from "@/lib/client";
import { useEffect, useState } from "react";
import { btnGhost, btnPrimary, btnSm, cx } from "@/lib/ui";
import Link from "next/link";
import { useAiEnabled } from "@/lib/ai-context";
import { openAsk } from "@/lib/ask-context";
import { useFeatures, type Feature } from "@/lib/features-context";
import { Modal } from "@/components/ui/Modal";
import { Menu } from "@/components/ui/Menu";
import type { ShellAttendance, ShellUser } from "@/components/shell/types";
import type { MessageKey } from "@/lib/i18n/core";
import { useFormat, useMeetEnabled, useT } from "@/lib/i18n/client";
import {
  ApprovalIcon,
  BellIcon,
  CalendarIcon,
  VideoIcon,
  ChatIcon,
  CheckCircleIcon,
  FileIcon,
  FolderIcon,
  HashIcon,
  PlusIcon,
  SearchIcon,
  SendIcon,
  SparkleIcon,
  WhiteboardIcon,
} from "./icons";
import { CREATE_EVENT } from "@/components/shell/BottomTabs";
import { AccountMenu, SHORTCUTS_EVENT } from "@/components/shell/AccountMenu";
import { CheckInPill } from "@/components/shell/CheckInPill";
import { Avatar } from "@/lib/people";
import { WorkspaceLogo } from "@/components/shell/WorkspaceHeader";
import { workTabOf } from "@/components/work/workTabAlias";
import { useScreenTitle } from "@/components/shell/ScreenTitle";

// Dialogs load when opened, not with every page.
const NewChannelModal = dynamic(() => import("@/components/chat/NewConversation").then((m) => m.NewChannelModal), { ssr: false });
const NewDmModal = dynamic(() => import("@/components/chat/NewConversation").then((m) => m.NewDmModal), { ssr: false });

// Both overlays load only when opened (keep the initial bundle small).
const CommandPalette = dynamic(() => import("./CommandPalette"), { ssr: false });
const NotificationPanel = dynamic(() => import("./NotificationPanel"), { ssr: false });

/** Work's areas by tab (/app/work/<tab>), for the bar's title. */
const AREA: Record<string, MessageKey> = {
  tasks: "shell.nav.tasks",
  docs: "shell.nav.docs",
  whiteboards: "shell.nav.whiteboards",
  calendar: "shell.nav.calendar",
  ops: "shell.nav.requests",
};

/** Where the destination in a breadcrumb leads back to. */
const HOME_OF: Partial<Record<MessageKey, string>> = {
  "shell.nav.tasks": "/app/work/tasks",
  "shell.nav.aiHub": "/app/ai",
  "shell.nav.docs": "/app/work/docs",
  "shell.nav.whiteboards": "/app/work/whiteboards",
  "shell.nav.calendar": "/app/work/calendar",
  "shell.nav.requests": "/app/work/ops",
  "shell.nav.messages": "/app/chat",
  "shell.nav.me": "/app/me",
  "shell.nav.time": "/app/time",
};

/** The destination a path belongs to, as the top bar's title (the only title a destination shows). */
function titleOf(path: string): MessageKey | null {
  if (path.startsWith("/app/home")) return "shell.nav.home";
  if (path.startsWith("/app/me/people")) return "shell.nav.people";
  if (path.startsWith("/app/me")) return "shell.nav.me";
  if (path.startsWith("/app/time")) return "shell.nav.time";
  if (path.startsWith("/app/chat")) return "shell.nav.messages";
  if (path.startsWith("/app/ai")) return "shell.nav.aiHub";
  if (path.startsWith("/app/search")) return "palette.search";
  if (path.startsWith("/app/announcements")) return "shell.nav.announcements";
  const tab = workTabOf(path);
  if (tab) return AREA[tab] ?? "shell.nav.tasks";
  if (path.startsWith("/app/work/docs")) return "shell.nav.docs";
  if (path.startsWith("/app/work/whiteboards")) return "shell.nav.whiteboards";
  if (path.startsWith("/app/work/meetings")) return "shell.nav.calendar";
  if (path.startsWith("/app/work/approvals")) return "shell.nav.requests";
  // A person's and a department's page belong to Work.
  if (path.startsWith("/app/work/people") || path.startsWith("/app/work/departments")) return "shell.nav.tasks";
  if (path.startsWith("/app/work")) return "shell.nav.tasks";
  return null;
}

/** One thing's own screen (or a named sub-page such as the company directory): the bar shows "Destination / Name".
 * Chat's list views are not entities; a workflow run's conversation (chat/ask/<run>) is, named after its task. */
const ENTITY =
  /^\/app\/(me\/people|work\/(projects|docs|whiteboards|tasks|meetings|approvals|people|departments)\/(?!new$)[^/]+|chat\/(?!(unreads|mentions|threads|saved|browse|general|m)$)[^/]+|chat\/ask\/[^/]+)$/;

/** The page's <title> without the unread prefix and the " · workspace" suffix: every entity route sets it. */
const pageName = () => {
  const raw = document.title.replace(/^\(\d+\+?\) /, "");
  // No " · workspace" suffix: the app's default title, not a page's own name.
  return raw.includes(" · ") ? raw.replace(/ · [^·]*$/, "").trim() : "";
};

/**
 * A task, request or meeting opened over a list (the intercepted @peek route) changes the URL but not the screen.
 * Intercepted, the slot's segment is the bare id; the catch-all (a full page, or nothing open) reports a path.
 */
function usePeeking() {
  const seg = useSelectedLayoutSegment("peek");
  return !!seg && seg !== "__DEFAULT__" && !seg.includes("/");
}

/** The entity's name for the breadcrumb: what the page set (ScreenCrumb), else its <title>, kept fresh. */
function useEntityName(path: string, destination: string, peeking: boolean) {
  const set = useScreenTitle()?.crumb ?? null;
  const entity = ENTITY.test(path) && !peeking;
  const [fromTitle, setFromTitle] = useState<string | null>(null);
  useEffect(() => {
    if (!entity) {
      setFromTitle(null);
      return;
    }
    const read = () => {
      const n = pageName();
      setFromTitle(n && n !== destination ? n : null);
    };
    read();
    const head = document.querySelector("head");
    if (!head) return;
    const obs = new MutationObserver(read);
    obs.observe(head, { subtree: true, childList: true, characterData: true });
    return () => obs.disconnect();
  }, [entity, path, destination]);
  return entity ? (set ?? fromTitle) : null;
}

/**
 * The screen's one title: the destination ("Lịch"), or on an entity screen a breadcrumb ("Việc /
 * Tuyển dụng 2026") whose first part leads back. On phones a frame's destination switcher ("Lịch ▾") stands in for
 * the plain name. `data-screen-title` is the stable hook for tests.
 */
function ScreenTitle({ path }: { path: string }) {
  const t = useT();
  const peeking = usePeeking();
  const liveKey = titleOf(path);
  const liveEntity = useEntityName(path, liveKey ? t(liveKey) : "", peeking);
  // While a Peek is open the bar keeps the title of the screen underneath (one detail pattern).
  const [frozen, setFrozen] = useState({ key: liveKey, entity: liveEntity });
  useEffect(() => {
    if (!peeking) setFrozen({ key: liveKey, entity: liveEntity });
  }, [peeking, liveKey, liveEntity]);
  const { key, entity } = peeking ? frozen : { key: liveKey, entity: liveEntity };
  const destination = key ? t(key) : "";
  const switcher = useScreenTitle()?.switcher ?? null;
  if (entity) {
    const href = key ? HOME_OF[key] : undefined;
    return (
      <nav aria-label={t("shell.top.breadcrumb")} data-screen-title="" className="flex min-w-0 items-center gap-1.5 text-sm">
        {href ? (
          <Link href={href} className="text-ink-2 hover:text-ink shrink-0 font-medium no-underline max-md:hidden">
            {destination}
          </Link>
        ) : (
          <span className="text-ink-2 shrink-0 font-medium max-md:hidden">{destination}</span>
        )}
        <span className="text-ink-2 select-none max-md:hidden" aria-hidden="true">
          /
        </span>
        <span aria-current="page" className="text-ink min-w-0 font-semibold max-md:line-clamp-2 max-md:leading-tight md:truncate">
          {entity}
        </span>
      </nav>
    );
  }
  return (
    <span className="flex min-w-0 items-center">
      {/* Phones: a long title (Spanish runs ~30% longer) wraps to two lines rather than losing its end. */}
      <span data-screen-title="" className={cx("text-ink min-w-0 text-sm font-semibold max-md:line-clamp-2 max-md:leading-tight md:truncate", switcher && "max-md:hidden")}>
        {destination}
      </span>
      {/* Phones: the frame's switcher is the title ("Lịch ▾"), at the bar's size; without its icon, so "Whiteboards"
          fits beside search, bell and avatar. */}
      {switcher ? <span className="flex min-w-0 md:hidden [&_button>svg:not(:last-child)]:hidden [&_button]:h-9 [&_button]:text-base/6">{switcher("title")}</span> : null}
    </span>
  );
}

/**
 * The top bar, inside the floating panel: 60px, a divider under it. The destination's name on the left;
 * in the centre the search pill (opens ⌘K) and the black "Tạo mới" pill; on the right "Hỏi AI" (when a model is
 * connected), the check-in pill (only when the workspace uses attendance) and notifications. The account menu lives
 * on the sidebar's workspace switcher. Phones: a 56px bar with the logo tile (account menu), the title, round search
 * and bell buttons; Tạo mới is the bottom bar's "+".
 */
export function TopBar({
  badge,
  user,
  workspace,
  logoColor,
  logoUrl,
  attendance,
}: {
  badge: number;
  user: ShellUser;
  workspace: string;
  logoColor: string | null;
  logoUrl?: string | null;
  attendance: ShellAttendance | null;
}) {
  const router = useRouter();
  const t = useT();
  const { time } = useFormat();
  const meet = useMeetEnabled();
  const screen = useScreenTitle();
  const path = usePathname();
  // Trợ lý AI only when the company connected a model; it is a top-bar action, not a sidebar destination.
  const ai = useAiEnabled();
  const has = useFeatures();
  const [palette, setPalette] = useState(false);
  const [inbox, setInbox] = useState(false);
  const [count, setCount] = useState(badge);

  // Keep the inbox dot fresh while the app stays open: every minute while visible, and on returning to the tab.
  useEffect(() => {
    setCount(badge);
  }, [badge]);
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible")
        void api<{ badge: number }>("home/notifications?count=1")
          .then((r) => setCount(r.badge))
          .catch(() => undefined);
    };
    const t = setInterval(refresh, 60_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Global shortcuts: "?" lists them, "g" then a letter jumps between areas, "c" opens Create.
  const [help, setHelp] = useState(false);
  const [createOpen, setCreateOpen] = useState(0);
  // The phone's round "+" in the bottom bar opens the same menu; the account menu's "Phím tắt" opens the list.
  useEffect(() => {
    const open = () => setCreateOpen((n) => n + 1);
    const keys = () => setHelp(true);
    window.addEventListener(CREATE_EVENT, open);
    window.addEventListener(SHORTCUTS_EVENT, keys);
    return () => {
      window.removeEventListener(CREATE_EVENT, open);
      window.removeEventListener(SHORTCUTS_EVENT, keys);
    };
  }, []);
  // New DM / channel open here, on the current screen: there is no Chat start page to send people to on desktop.
  const [newChat, setNewChat] = useState<"dm" | "channel" | null>(null);
  useEffect(() => {
    let g = 0;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey || t?.closest("input, textarea, select, [contenteditable=true], [role=dialog]")) return;
      if (e.key === "?") {
        e.preventDefault();
        setHelp(true);
        return;
      }
      if (e.key === "c") {
        e.preventDefault();
        setCreateOpen((n) => n + 1);
        return;
      }
      if (e.key === "g") {
        g = Date.now();
        return;
      }
      if (Date.now() - g < 1200) {
        const to = (
          {
            h: "/app/home",
            i: "/app/chat",
            c: "/app/chat",
            w: "/app/work/tasks",
            // "Go to" a destination the deployment left out goes nowhere.
            ...(has("docs") ? { d: "/app/work/docs" } : {}),
            m: "/app/me",
            ...(has("time") ? { k: "/app/time" } : {}),
            t: "/app/work/tasks?scope=assigned",
            ...(has("calendar") ? { l: "/app/work/calendar" } : {}),
            a: "/app/work/ops",
          } as Record<string, string>
        )[e.key];
        g = 0;
        if (to) {
          e.preventDefault();
          router.push(to);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router, has]);
  const create = [
    { label: t("shell.top.newTask"), icon: <CheckCircleIcon />, onSelect: () => router.push("/app/work/tasks?new=task") },
    { label: t("shell.top.newProject"), icon: <FolderIcon />, onSelect: () => router.push("/app/work/tasks?view=projects&new=project") },
    ...(meet
      ? [
          {
            label: t("meet.startNow"),
            icon: <VideoIcon />,
            onSelect: () => void openMeeting(router, { title: t("meet.quickTitle", { time: time(new Date()) }) }).catch(() => undefined),
          },
        ]
      : []),
    ...(has("calendar") ? [{ label: t("shell.top.newMeeting"), icon: <CalendarIcon />, onSelect: () => router.push("/app/work/calendar?new=event") }] : []),
    ...(has("docs") ? [{ label: t("shell.top.newDoc"), icon: <FileIcon />, onSelect: () => router.push("/app/work/docs/new") }] : []),
    ...(has("whiteboards") ? [{ label: t("shell.top.newWhiteboard"), icon: <WhiteboardIcon />, onSelect: () => router.push("/app/work/whiteboards?new=whiteboard") }] : []),
    { label: t("shell.top.newDm"), icon: <ChatIcon />, onSelect: () => setNewChat("dm") },
    { label: t("shell.top.newChannel"), icon: <HashIcon />, onSelect: () => setNewChat("channel") },
    { label: t("shell.top.newApproval"), icon: <ApprovalIcon />, onSelect: () => router.push("/app/work/ops?new=request") },
    ...(has("time") ? [{ label: t("shell.top.newLeave"), icon: <SendIcon />, onSelect: () => router.push("/app/time?tab=leave&new=leave") }] : []),
  ];

  const bell = (
    <button
      type="button"
      className="text-ink-soft hover:bg-hover hover:text-ink max-md:bg-hover relative grid size-9 shrink-0 place-items-center rounded-md transition-colors max-md:size-10 max-md:rounded-full"
      onClick={() => setInbox(true)}
      aria-label={count ? t("shell.top.notificationsCount", { count }) : t("shell.top.notifications")}
      aria-haspopup="dialog"
    >
      <BellIcon className="size-5" />
      {count > 0 ? (
        <span
          className="bg-signal text-on-brand ring-surface absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full px-1 text-[11px] font-semibold tabular-nums leading-none ring-2"
          aria-hidden="true"
        >
          {count > 99 ? "99+" : count}
        </span>
      ) : null}
    </button>
  );

  // The corner avatar: my profile, status, language, sign out.
  const account = (
    <AccountMenu
      user={user}
      align="right"
      trigger={
        <span className="hover:bg-hover grid size-9 shrink-0 place-items-center rounded-full transition-colors max-md:size-10">
          <Avatar id={user.userId} name={user.name} size="sm" />
        </span>
      }
    />
  );

  return (
    // 48px on desktop (56px on phones), flush with the content, one hairline under it.
    <header className="bg-surface sticky top-0 z-20 print:hidden">
      <div className="border-hairline bg-surface h-14 border-b md:h-12">
        {/* Phones: logo tile, the title, round search and bell. */}
        <div className="group/bar flex h-full items-center gap-2.5 px-4 md:hidden">
          <HistoryNav className="-ml-1.5" />
          <WorkspaceLogo name={workspace} color={logoColor} logoUrl={logoUrl} className="size-[30px] shrink-0 rounded-[9px] text-[11px]" />
          <span className="flex min-w-0 flex-1">
            <ScreenTitle path={path} />
          </span>
          {/* A full-height screen's own actions (ScreenActions); search steps aside while they are there. */}
          <div ref={screen?.setActionsEl} data-screen-actions="" className="flex shrink-0 items-center gap-0.5 empty:hidden" />
          {ai && !path.startsWith("/app/ai/ask") ? (
            <button
              type="button"
              onClick={() => openAsk()}
              aria-haspopup="dialog"
              aria-label={t("aiw.panel.open")}
              className="bg-hover text-ink grid size-10 place-items-center rounded-full group-has-[[data-screen-actions]>*]/bar:hidden"
            >
              <SparkleIcon className="size-[18px]" />
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setPalette(true)}
            aria-haspopup="dialog"
            aria-label={t("shell.top.search")}
            className="bg-hover text-ink grid size-10 place-items-center rounded-full group-has-[[data-screen-actions]>*]/bar:hidden"
          >
            <SearchIcon className="size-[18px]" />
          </button>
          {bell}
          {account}
          {/* The bottom bar's "+" opens this one as a sheet (the desktop menu below is not displayed on phones). */}
          <Menu
            key={createOpen}
            defaultOpen={createOpen > 0}
            sheetOnMobile
            label={t("shell.top.create")}
            items={create}
            trigger={<span className="sr-only">{t("shell.top.create")}</span>}
          />
        </div>
        {/* Desktop: title | search + Tạo mới (centred, ≤ 560px) | AI, check-in, bell. Tablets: the title keeps its width
            (up to 14rem) and search takes the rest, so "Của tôi" never shrinks to "C…". The right column never goes below
            its content (AI, the clocked-in chip, bell): the search narrows instead of Tạo mới sliding over them. The title
            keeps at least 11rem on laptops too, so "Của tôi / Danh bạ công ty" is not cut to "Của tôi / D…" at 1280px. */}
        <div className="hidden h-full grid-cols-[fit-content(14rem)_minmax(0,1fr)_auto] items-center gap-3 px-4 md:grid lg:grid-cols-[minmax(11rem,1fr)_minmax(0,480px)_minmax(max-content,1fr)]">
          {/* The desktop app's Back/Forward (none in a browser, which has its own) sit before the title. */}
          <div className="flex min-w-0 items-center gap-2">
            <HistoryNav className="-ml-1.5" />
            <ScreenTitle path={path} />
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              onClick={() => setPalette(true)}
              aria-haspopup="dialog"
              className="border-hairline bg-hover/60 text-ink-2 hover:bg-hover hover:border-edge flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border pl-2.5 pr-1.5 text-left text-sm transition-colors"
            >
              <SearchIcon className="size-3.5 shrink-0" />
              <span className="flex-1 truncate">{t("shell.top.search")}</span>
              <kbd className="border-hairline bg-surface text-ink-2 rounded-sm border px-1 font-sans text-[11px] font-medium leading-4 max-lg:hidden">⌘K</kbd>
            </button>
            <Menu
              key={createOpen}
              defaultOpen={createOpen > 0}
              sheetOnMobile
              label={t("shell.top.create")}
              items={create}
              trigger={
                /* The one always-present solid pill: creating is the bar's main action. */
                <span className={cx(btnPrimary, "max-xl:px-2.5")} title={t("shell.top.create")}>
                  <PlusIcon className="size-3.5" />
                  {/* Below 1280 the plus alone: with the title, Hỏi AI and the clock-in pill the search read "Tìm…". */}
                  <span className="max-xl:sr-only">{t("shell.top.create")}</span>
                </span>
              }
            />
          </div>
          <div className="flex min-w-0 items-center justify-end gap-2">
            {ai ? (
              <Link
                href="/app/ai/ask"
                aria-current={path.startsWith("/app/ai/ask") ? "page" : undefined}
                className={cx(btnGhost, btnSm, "aria-[current=page]:bg-selected shrink-0 max-xl:px-2")}
                title={t("aiw.panel.shortcut")}
                // A plain click asks beside the screen (the ask panel, ⌘J); a new tab or Hỏi đáp itself opens the page.
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0 || path.startsWith("/app/ai/ask")) return;
                  e.preventDefault();
                  openAsk();
                }}
              >
                <SparkleIcon className="size-4" />
                <span className="max-xl:sr-only">{t("shell.nav.askAi")}</span>
              </Link>
            ) : null}
            {attendance ? <CheckInPill attendance={attendance} /> : null}
            {bell}
            {account}
          </div>
        </div>
      </div>
      {palette ? <CommandPalette isAdmin={user.isAdmin} onClose={() => setPalette(false)} /> : null}
      {help ? <ShortcutsDialog onClose={() => setHelp(false)} /> : null}
      {newChat === "dm" ? <NewDmModal onClose={() => setNewChat(null)} /> : null}
      {newChat === "channel" ? <NewChannelModal onClose={() => setNewChat(null)} /> : null}
      {inbox ? <NotificationPanel onClose={() => setInbox(false)} onBadge={setCount} /> : null}
      <ConnectionBanner />
    </header>
  );
}

const SHORTCUTS = [
  [
    "shell.keys.general",
    [
      ["⌘K / Ctrl K", "shell.keys.searchCmd"],
      ["⌘J / Ctrl J", "shell.keys.askAi"],
      ["c", "shell.keys.create"],
      ["?", "shell.keys.list"],
    ],
  ],
  [
    "shell.keys.goTo",
    [
      ["g h", "shell.nav.home"],
      ["g i", "shell.nav.messages"],
      ["g w", "shell.nav.tasks"],
      ["g t", "shell.keys.myTasks"],
      ["g d", "shell.nav.docs"],
      ["g l", "shell.nav.calendar"],
      ["g a", "shell.nav.requests"],
      ["g m", "shell.keys.me"],
    ],
  ],
  [
    "shell.keys.inChat",
    [
      ["Enter", "shell.keys.send"],
      ["Shift Enter", "shell.keys.newline"],
      ["↑", "shell.keys.editLast"],
      ["Ctrl B / Ctrl I", "shell.keys.boldItalic"],
      ["@", "shell.keys.mention"],
    ],
  ],
] as const;

/** "Go to" rows that lead to a feature a deployment can leave out. */
const SHORTCUT_FEATURE: Partial<Record<MessageKey, Feature>> = { "shell.nav.docs": "docs", "shell.nav.calendar": "calendar" };

function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const ai = useAiEnabled();
  const has = useFeatures();
  return (
    <Modal title={t("shell.keys.title")} onClose={onClose}>
      <div className="grid gap-5 sm:grid-cols-2">
        {SHORTCUTS.map(([group, rows]) => (
          <section key={group} aria-label={t(group)}>
            <h3 className="text-ink-2 mb-2 text-xs font-semibold">{t(group)}</h3>
            <dl className="m-0 grid gap-1.5 text-sm">
              {rows
                .filter(([, v]) => has(SHORTCUT_FEATURE[v]) && (v !== "shell.keys.askAi" || ai))
                .map(([k, v]) => (
                  <div key={v} className="flex items-center justify-between gap-3">
                    <dt>{t(v === "shell.keys.mention" && !ai ? "shell.keys.mentionNoAi" : v)}</dt>
                    <dd className="m-0 flex gap-1">
                      {k
                        .split(" / ")[0]!
                        .split(" ")
                        .map((x) => (
                          <kbd key={x} className="border-hairline bg-ground rounded-sm border px-1.5 py-0.5 font-mono text-xs">
                            {x}
                          </kbd>
                        ))}
                    </dd>
                  </div>
                ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}
