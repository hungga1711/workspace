"use client";

import Link from "next/link";
import { useT } from "@/lib/i18n/client";
import { usePathname } from "next/navigation";
import { cx } from "@/lib/ui";
import { BoardIcon, ChatIcon, ClockIcon, HomeIcon, MeIcon, PlusIcon, SparkleIcon } from "@/components/app/icons";
import { useFeature } from "@/lib/features-context";
import { useIntentPrefetch } from "@/lib/intent-prefetch";
import { navTarget } from "./navTarget";

/** The top bar listens for this and opens Tạo mới (one menu, two ways in). */
export const CREATE_EVENT = "wx:create";

/** Four tabs around the "+": Trang chủ · Tin nhắn · (+) · Việc · Chấm công (the profile is the top bar's avatar). Work's other areas switch from
 * Việc's title; Trợ lý AI is the top bar's "Hỏi AI". */
const TABS = [
  { href: "/app/home", label: "shell.nav.home", Icon: HomeIcon },
  { href: "/app/chat", label: "shell.nav.messages", Icon: ChatIcon },
  { href: "/app/work", label: "shell.nav.tasks", Icon: BoardIcon },
  { href: "/app/time", label: "shell.nav.time", Icon: ClockIcon },
] as const;
const ME_TAB = { href: "/app/me", label: "shell.nav.me", Icon: MeIcon } as const;

/**
 * Mobile primary navigation (design Issue 9): bottom bar, 44px+ targets, with Tạo mới as the round button in the
 * middle (the top bar's "+" is desktop-only), so creating something is always one thumb away. The current tab's
 * icon and label are accent-text and semibold, no rule or pill (same as the sidebar's selected row).
 */
/** AI Insights only: Home and AI, nothing to create. */
const INSIGHTS_TABS = [
  { href: "/app/home", label: "shell.nav.home", Icon: HomeIcon },
  { href: "/app/ai", label: "shell.nav.aiHub", Icon: SparkleIcon },
] as const;

export function BottomTabs({ mentions, insightsOnly = false }: { mentions: boolean; insightsOnly?: boolean }) {
  const path = usePathname();
  const t = useT();
  const time = useFeature("time");
  const intent = useIntentPrefetch();
  const tab = ({
    href,
    label,
    Icon,
  }: {
    href: string;
    label: (typeof TABS)[number]["label"] | (typeof INSIGHTS_TABS)[number]["label"] | "shell.nav.me";
    Icon: (typeof TABS)[number]["Icon"];
  }) => {
    const active = path.startsWith(href);
    return (
      <Link
        key={href}
        href={navTarget(href)}
        {...intent(navTarget(href))}
        aria-current={active ? "page" : undefined}
        className={cx("relative grid place-items-center content-center gap-0.5 text-[12px] font-medium no-underline", active ? "text-accent-text font-semibold" : "text-ink-2")}
      >
        <span className="grid h-7 w-12 place-items-center">
          <Icon className="size-5" />
        </span>
        {t(label)}
        {href === "/app/chat" && mentions ? <span className="bg-signal absolute left-[calc(50%+8px)] top-2 size-2 rounded-full" aria-hidden="true" /> : null}
      </Link>
    );
  };
  if (insightsOnly)
    return (
      <nav
        className="border-divider bg-surface fixed inset-x-0 bottom-0 z-30 grid h-[calc(4rem+env(safe-area-inset-bottom))] grid-cols-2 border-t px-2 pb-[env(safe-area-inset-bottom)] md:hidden print:hidden"
        aria-label={t("shell.nav.main")}
      >
        {INSIGHTS_TABS.map(tab)}
      </nav>
    );
  return (
    <nav
      className="border-divider bg-surface fixed inset-x-0 bottom-0 z-30 grid h-[calc(4rem+env(safe-area-inset-bottom))] grid-cols-5 border-t px-2 pb-[env(safe-area-inset-bottom)] md:hidden print:hidden"
      aria-label={t("shell.nav.main")}
    >
      {TABS.slice(0, 2).map(tab)}
      <div className="grid place-items-center">
        <button
          type="button"
          onClick={() => window.dispatchEvent(new Event(CREATE_EVENT))}
          aria-label={t("shell.top.create")}
          aria-haspopup="menu"
          className="bg-brand text-on-brand grid size-11 place-items-center rounded-full transition-transform active:scale-95"
        >
          <PlusIcon className="size-5" />
        </button>
      </div>
      {/* Without Time (left out at deploy time) the profile takes its place, so the "+" stays in the middle. */}
      {TABS.slice(2).map((x) => tab(x.href === "/app/time" && !time ? ME_TAB : x))}
    </nav>
  );
}
