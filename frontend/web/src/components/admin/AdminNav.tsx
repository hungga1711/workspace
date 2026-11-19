"use client";

import type { T } from "@/lib/i18n/core";
import { useT } from "@/lib/i18n/client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { cx, navActive, navIcon, navIdle, navItem } from "@/lib/ui";
import { Tabs } from "@/components/ui/Tabs";
import { IconTile, card, type Tone } from "@/components/ui/Bento";
import { Picker } from "@/components/ui/Picker";
import { PageCrumbProvider, usePageCrumb, type CrumbRender } from "@/components/ui/PageCrumb";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/client";
import { attentionSources } from "./attention-sources";
import { canOpen, sectionFeature } from "./page-perms";
import { ArrowRightIcon, BotIcon, ChartIcon, ClockIcon, ListIcon, MegaphoneIcon, SettingsIcon, ShieldIcon, UsersIcon, WorkIcon } from "@/components/app/icons";

interface Page {
  href: string;
  label: string;
}
/** One nav entry; `pages` are its sub-pages, shown as tabs above the content (each keeps its own URL). */
interface Section {
  href: string;
  label: string;
  Icon: (p: { className?: string }) => React.ReactNode;
  pages?: Page[];
  /** The overview's section tiles: the icon tile's tone and one line on what lives there. */
  tone?: Tone;
  desc?: string;
}

/**
 * Ten entries in three groups. Related pages share one entry and switch with tabs:
 * members and roles, timesheets/leave/holidays, AI connections and agents, sign-in/integrations/activity log.
 */
const GROUPS = (tx: T): { label: string; items: Section[] }[] => [
  { label: "", items: [{ href: "/admin/workspace", label: tx("admin.adminnav.tong_quan"), Icon: ChartIcon }] },
  {
    label: tx("admin.adminnav.con_nguoi"),
    items: [
      {
        href: "/admin/workspace/members",
        label: tx("admin.adminnav.thanh_vien"),
        Icon: UsersIcon,
        tone: "violet",
        desc: tx("admin.adminnav.d_members"),
        pages: [
          // Tabs never repeat their section's name: "Danh sách · Vai trò & quyền" under Thành viên.
          { href: "/admin/workspace/members", label: tx("admin.adminnav.danh_sach") },
          { href: "/admin/workspace/roles", label: tx("admin.adminnav.vai_tro_quyen") },
        ],
      },
      { href: "/admin/workspace/teams", label: tx("admin.adminnav.team_phong_ban"), Icon: WorkIcon, tone: "sky", desc: tx("admin.adminnav.d_teams") },
      {
        href: "/admin/workspace/attendance",
        label: tx("admin.adminnav.cham_cong_nghi"),
        Icon: ClockIcon,
        tone: "tangerine",
        desc: tx("admin.adminnav.d_time"),
        pages: [
          { href: "/admin/workspace/attendance", label: tx("admin.adminnav.bang_cong") },
          { href: "/admin/workspace/leave", label: tx("admin.adminnav.phep_nam") },
          { href: "/admin/workspace/leave/requests", label: tx("admin.adminnav.don_nghi") },
          { href: "/admin/workspace/holidays", label: tx("admin.adminnav.ngay_le") },
        ],
      },
    ],
  },
  {
    label: "Workspace",
    items: [
      { href: "/admin/workspace/settings", label: tx("admin.adminnav.cai_dat_tinh_nang"), Icon: SettingsIcon, tone: "sky", desc: tx("admin.adminnav.d_settings") },
      { href: "/admin/workspace/announcements", label: tx("admin.adminnav.thong_bao_cong_ty"), Icon: MegaphoneIcon, tone: "rose", desc: tx("admin.adminnav.d_announcements") },
      { href: "/admin/workspace/custom-fields", label: tx("admin.adminnav.truong_tuy_chinh"), Icon: ListIcon, tone: "green", desc: tx("admin.adminnav.d_fields") },
    ],
  },
  {
    label: tx("admin.adminnav.he_thong"),
    items: [
      {
        href: "/admin/workspace/ai",
        label: tx("aic.title"),
        Icon: BotIcon,
        tone: "violet",
        desc: tx("admin.adminnav.d_ai"),
        // Connection · Insights · Privacy · Cost & limits · Danger zone. Agents (identities that act for people) live
        // with sign-in and API access under Security, next to MCP access, not here.
        pages: [
          { href: "/admin/workspace/ai", label: tx("admin.adminnav.ket_noi_ai") },
          { href: "/admin/workspace/ai/insights", label: tx("admin.adminnav.aiInsightsTab") },
          { href: "/admin/workspace/ai/privacy", label: tx("admin.adminnav.aiPrivacyTab") },
          { href: "/admin/workspace/ai/cost", label: tx("admin.adminnav.aiCostTab") },
          { href: "/admin/workspace/ai/danger", label: tx("admin.adminnav.dangerTab") },
        ],
      },
      {
        href: "/admin/workspace/security",
        label: tx("admin.adminnav.bao_mat_tich_hop"),
        Icon: ShieldIcon,
        tone: "green",
        desc: tx("admin.adminnav.d_security"),
        pages: [
          { href: "/admin/workspace/security", label: tx("admin.adminnav.dang_nhap") },
          { href: "/admin/workspace/integrations", label: tx("admin.adminnav.api_webhooks") },
          { href: "/admin/workspace/integrations/task-sync", label: tx("taskSync.title") },
          { href: "/admin/workspace/agents", label: tx("admin.adminnav.agents") },
          { href: "/admin/workspace/mcp", label: tx("mcpServer.admin.nav") },
          { href: "/admin/workspace/audit", label: tx("admin.adminnav.nhat_ky") },
          { href: "/admin/workspace/errors", label: tx("admin.adminnav.loi_trinh_duyet") },
        ],
      },
    ],
  },
];

/** The viewer's permission tokens (page-perms.ts), from the admin layout; null = unknown, show everything. */
const PermsCtx = createContext<ReadonlySet<string> | null>(null);
/** The workspace's feature flags (aiAssistant, aiMonitoring…), so section tabs hide pages whose routes are off. */
const FeaturesCtx = createContext<Record<string, boolean> | null>(null);
export function AdminPermsProvider({ perms, features = null, children }: { perms: string[] | null; features?: Record<string, boolean> | null; children: React.ReactNode }) {
  const set = useMemo(() => (perms ? new Set(perms) : null), [perms]);
  return (
    <PermsCtx.Provider value={set}>
      <FeaturesCtx.Provider value={features}>{children}</FeaturesCtx.Provider>
    </PermsCtx.Provider>
  );
}

/** Whether this viewer can open an admin page (a "Lịch sử" link only for those who may read the audit log). */
export function useCanOpen(href: string): boolean {
  return canOpen(useContext(PermsCtx), href);
}

/**
 * The sections and tabs this viewer can open (same map as the page gates): a Manager is not offered entries that
 * only answer "no access". A section whose first page is hidden starts at its first visible one.
 */
function usePermittedGroups(): { label: string; items: Section[] }[] {
  const tx = useT();
  const perms = useContext(PermsCtx);
  return GROUPS(tx)
    .map((g) => ({
      ...g,
      items: g.items.flatMap((it) => {
        const pages = it.pages?.filter((p) => canOpen(perms, p.href));
        if (it.pages ? !pages?.length : !canOpen(perms, it.href)) return [];
        return [pages ? { ...it, href: pages[0]!.href, pages } : it];
      }),
    }))
    .filter((g) => g.items.length);
}

/** The sections this viewer can open on this installation: by permission, then by the workspace's features. */
function useGroups(): { label: string; items: Section[] }[] {
  return withFeatures(usePermittedGroups(), useContext(FeaturesCtx));
}

/**
 * Admin › AI always (that is where the switches are). Cost & limits and Agents only once the assistant is on; Insights
 * and Privacy only with AI Insights (extension monitoring) on: their routes answer 404 otherwise.
 */
const NEEDS: Record<string, string> = {
  "/admin/workspace/ai/cost": "aiAssistant",
  "/admin/workspace/agents": "aiAssistant",
  "/admin/workspace/ai/insights": "aiMonitoring",
  "/admin/workspace/ai/privacy": "aiMonitoring",
};
const withFeatures = (groups: { label: string; items: Section[] }[], features?: Record<string, boolean> | null) => {
  if (!features) return groups;
  // A feature the deployment left out (DISABLED_FEATURES) takes its pages with it; a section left with none goes too,
  // and one whose first page went starts at its first remaining one (Time & leave → Holidays).
  const shown = (href: string) => {
    const left = sectionFeature(href);
    return !(left && features[left] === false) && (!NEEDS[href] || features[NEEDS[href]!]);
  };
  return groups
    .map((g) => ({
      ...g,
      items: g.items.flatMap((it) => {
        if (!it.pages) return sectionFeature(it.href) && !shown(it.href) ? [] : [it];
        const pages = it.pages.filter((p) => shown(p.href));
        if (!pages.length) return [];
        // One page left of a section that lost the rest (Time & leave without Chấm công is only Public holidays):
        // the entry is that page, under its own name.
        if (pages.length === 1 && it.pages.length > 1 && sectionFeature(it.href) && !shown(it.href)) {
          const { pages: _all, desc: _desc, ...entry } = it;
          return [{ ...entry, href: pages[0]!.href, label: pages[0]!.label }];
        }
        return [{ ...it, href: pages[0]!.href, pages }];
      }),
    }))
    .filter((g) => g.items.length);
};

const under = (path: string, href: string) => path === href || path.startsWith(`${href}/`);

/** The section a path belongs to (its own entry or one of its tab pages). */
function sectionOf(groups: { items: Section[] }[], path: string): Section | undefined {
  for (const g of groups)
    for (const s of g.items) {
      if (s.href === "/admin/workspace" ? path === s.href : (s.pages ?? [s]).some((p) => under(path, p.href))) return s;
    }
  return undefined;
}

/**
 * How many things need an admin (the overview's "Needs you" list), for the mark on the menu's Overview entry. Asked
 * when the admin area opens and again on each return to the overview; a part that cannot be read counts as nothing
 * here (the overview itself says "could not check").
 */
function useAttentionCount(path: string) {
  const perms = useContext(PermsCtx);
  const features = useContext(FeaturesCtx);
  const [count, setCount] = useState(0);
  const onOverview = path === "/admin/workspace";
  useEffect(() => {
    let stop = false;
    void Promise.all(
      attentionSources(perms, features).map((m) =>
        api<{ items: unknown[] }>(`${m}/attention`)
          .then((r) => r.items.length)
          .catch(() => 0),
      ),
    ).then((n) => {
      if (!stop) setCount(n.reduce((a, b) => a + b, 0));
    });
    return () => {
      stop = true;
    };
  }, [perms, features, onOverview]);
  return count;
}

/** Admin areas, grouped; a self-hosted workspace has every module, so there are no plan badges. */
export function AdminNav({ features }: { features?: Record<string, boolean> | null }) {
  const tx = useT();
  const path = usePathname();
  const groups = withFeatures(useGroups(), features);
  const current = sectionOf(groups, path);
  const needs = useAttentionCount(path);
  return (
    // Tablets (768–1023 px) show it as a 64 px icon rail; labels stay as accessible names and tooltips.
    <nav className="hidden gap-3 px-2 pb-3 pt-1 md:grid md:max-lg:gap-2 lg:pl-2 lg:pr-2.5" aria-label={tx("admin.adminnav.muc_quan_tri")}>
      {groups.map((g) => (
        <div key={g.label || "overview"} className="grid gap-0.5">
          {g.label ? <p className="text-ink-2 px-3 pb-1.5 pt-2 text-xs font-medium max-lg:sr-only">{g.label}</p> : null}
          {g.items.map(({ href, label, Icon }) => {
            const active = current?.href === href;
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                title={label}
                className={cx(navItem, "relative shrink-0 max-lg:justify-center max-lg:px-0", active ? navActive : navIdle)}
              >
                <Icon className={navIcon(active)} />
                <span className="truncate max-lg:sr-only">{label}</span>
                {/* What needs an admin, on the way to the list that says what: a count, or a dot on the icon rail. */}
                {href === "/admin/workspace" && needs ? (
                  <span
                    className="bg-block-wash text-block ml-auto rounded-full px-1.5 text-[11px]/[18px] font-semibold tabular-nums max-lg:absolute max-lg:right-2.5 max-lg:top-1.5 max-lg:size-2 max-lg:bg-current max-lg:p-0 max-lg:text-[0px]"
                    title={`${tx("admin.needs.title")}: ${tx("admin.needs.count", { count: needs })}`}
                  >
                    {needs}
                  </span>
                ) : null}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

/**
 * Phones have no admin sidebar: every admin page's header offers the sections as its title switcher
 * ("Thành viên ▾"), the same pattern as the app's destinations, so the title sits where it does everywhere else.
 */
export function AdminFrame({ children }: { children: React.ReactNode }) {
  const tx = useT();
  const path = usePathname();
  const router = useRouter();
  const groups = useGroups();
  const current = sectionOf(groups, path);
  const render: CrumbRender = (variant) => (
    <Picker
      variant={variant}
      label={tx("admin.adminnav.muc_quan_tri")}
      value={current?.href ?? "/admin/workspace"}
      onChange={(href) => router.push(href)}
      options={groups.flatMap((g) => g.items).map(({ href, label, Icon }) => ({ value: href, label, icon: <Icon className="text-ink-2 size-4" /> }))}
    />
  );
  return <PageCrumbProvider render={render}>{children}</PageCrumbProvider>;
}

/** The pages of the current section as tabs (Bảng công · Phép năm · Ngày lễ); nothing for single pages. */
function SectionTabs() {
  const path = usePathname();
  const section = sectionOf(withFeatures(useGroups(), useContext(FeaturesCtx)), path);
  if (!section?.pages) return null;
  const active = [...section.pages].sort((a, b) => b.href.length - a.href.length).find((p) => under(path, p.href));
  const current = active?.href ?? section.href;
  return (
    <>
      <div className="border-divider border-b max-lg:hidden">
        <Tabs label={section.label} tabs={section.pages.map((p) => ({ key: p.href, label: p.label, href: p.href }))} active={current} />
      </div>
      {/* Below 1024px a row of up to seven tabs (Bảo mật & tích hợp) runs off the screen: the pages wrap as a pill
          track instead, two to a row on phones, so every page stays in sight in every language. */}
      <nav aria-label={section.label} className="bg-hover grid grid-cols-2 gap-0.5 rounded-md p-0.5 sm:flex sm:flex-wrap lg:hidden">
        {section.pages.map((p) => {
          const on = p.href === current;
          return (
            <Link
              key={p.href}
              href={p.href}
              aria-current={on ? "page" : undefined}
              className={cx(
                "flex min-h-8 min-w-0 items-center justify-center rounded-[5px] px-2.5 py-1 text-center text-[13px]/4 no-underline transition-colors max-sm:min-h-10",
                on ? "bg-surface shadow-raised text-ink font-medium" : "text-ink-2 hover:text-ink",
              )}
            >
              {p.label}
            </Link>
          );
        })}
      </nav>
    </>
  );
}

/**
 * Quản trị's top-bar title (one title per screen): "Quản trị / Thành viên", the section being viewed; the
 * page itself repeats neither. `data-screen-title` is the stable hook for tests, as in the app's top bar.
 */
export function AdminTitle() {
  const tx = useT();
  const path = usePathname();
  const section = sectionOf(GROUPS(tx), path);
  const root = tx("admin.layout.quan_tri");
  if (!section || section.href === "/admin/workspace")
    return (
      <span data-screen-title="" className="text-ink min-w-0 truncate text-sm font-semibold">
        {root}
      </span>
    );
  return (
    <nav aria-label={tx("shell.top.breadcrumb")} data-screen-title="" className="flex min-w-0 items-center gap-1.5 text-sm">
      <Link href="/admin/workspace" className="text-ink-2 hover:text-ink shrink-0 font-medium no-underline">
        {root}
      </Link>
      <span className="text-ink-2 select-none" aria-hidden="true">
        /
      </span>
      <span aria-current="page" className="text-ink min-w-0 truncate font-semibold">
        {section.label}
      </span>
    </nav>
  );
}

/**
 * Every admin page's header (the Home look): the section's group as a small-caps eyebrow with a short
 * blue rule, the page title tight in the display face, one muted line under it, actions on the right; the section's
 * sibling pages as tabs on a hairline below. On phones (no admin sidebar or top bar) the eyebrow is the section
 * switcher ("Thành viên ▾").
 */
export function AdminHeader({ title: titleProp, sub, actions }: { title?: string; sub?: React.ReactNode; actions?: React.ReactNode }) {
  const tx = useT();
  const path = usePathname();
  const groups = useGroups();
  const section = sectionOf(groups, path);
  const crumb = usePageCrumb();
  const grouped = !!section?.pages;
  // Without a title (a page whose read failed), the section's own name.
  const title = titleProp ?? section?.label ?? tx("admin.layout.quan_tri");
  return (
    <header className="mb-6 min-w-0 max-md:mb-5">
      <div className="flex min-w-0 flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0 flex-[1_1_18rem]">
          {crumb ? <div className="mb-1 flex min-w-0 md:hidden">{crumb("crumb")}</div> : null}
          <h1 data-page-title="" className="font-display text-ink m-0 text-balance text-[28px]/[1.15] font-semibold tracking-[-0.035em] max-sm:text-2xl/[1.2]">
            {title}
          </h1>
          {sub ? <div className="text-ink-2 mt-1.5 max-w-[72ch] text-sm/[1.45]">{sub}</div> : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2 max-sm:w-full">{actions}</div> : null}
      </div>
      {grouped ? (
        <div className="mt-4">
          <SectionTabs />
        </div>
      ) : null}
    </header>
  );
}

/**
 * The overview's bento of sections: every section this viewer can open as a tile (tinted icon, name,
 * one line on what lives there, its tabs as small links), grouped like the menu. The whole tile leads to the
 * section; the tab links sit above that.
 */
export function AdminSectionTiles({ features }: { features?: Record<string, boolean> | null }) {
  const tx = useT();
  const groups = withFeatures(useGroups(), features).filter((g) => g.label);
  if (!groups.length) return null;
  return (
    <section aria-labelledby="sections-h" className="@container">
      <h2 id="sections-h" className="text-ink m-0 mb-3 mt-1 text-sm font-semibold">
        {tx("admin.adminnav.muc_quan_tri")}
      </h2>
      <ul className="@[56rem]:grid-cols-3 @[84rem]:grid-cols-4 m-0 grid list-none grid-cols-2 gap-4 p-0 max-md:gap-3">
        {groups.flatMap((g) =>
          g.items.map(({ href, label, Icon, tone, desc, pages }) => (
            <li key={href} className={cx(card, "group/tile flex min-w-0 flex-col rounded-xl p-5 max-sm:p-3.5")}>
              <span className="flex min-h-8 min-w-0 items-center gap-3">
                <IconTile tone={tone ?? "sky"}>
                  <Icon />
                </IconTile>
                <Link
                  href={href}
                  className="text-ink line-clamp-2 min-w-0 flex-1 text-sm/[1.3] font-semibold tracking-[-0.01em] no-underline after:absolute after:inset-0 after:z-[1] after:rounded-[inherit]"
                >
                  {label}
                </Link>
                <ArrowRightIcon className="text-ink-2 size-4 shrink-0 transition-transform group-hover/tile:translate-x-0.5 max-sm:hidden" />
              </span>
              {desc ? <p className="text-ink-2 m-0 mt-2.5 text-[13px]/[1.45] max-sm:hidden">{desc}</p> : null}
              {pages && pages.length > 1 ? (
                <span className="relative z-[2] mt-3 flex flex-wrap gap-1.5 max-sm:hidden">
                  {pages.map((p) => (
                    <Link
                      key={p.href}
                      href={p.href}
                      className="bg-ground ring-hairline text-ink-2 hover:bg-hover hover:text-ink hover:ring-edge inline-flex min-h-7 items-center rounded-full px-2.5 text-xs no-underline ring-1 ring-inset transition-[background-color,box-shadow,color]"
                    >
                      {p.label}
                    </Link>
                  ))}
                </span>
              ) : null}
            </li>
          )),
        )}
      </ul>
    </section>
  );
}
