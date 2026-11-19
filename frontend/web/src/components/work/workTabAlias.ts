// A plain module (not "use client"): the server pages, the middleware and the client tab bar all read it.

/** Work's tabs, each at its own address: /app/work/tasks, /app/work/calendar… */
export const WORK_TAB_KEYS = ["tasks", "goals", "docs", "whiteboards", "calendar", "ops"] as const;
export type WorkTabKey = (typeof WORK_TAB_KEYS)[number];
const isTab = (k: string | undefined): k is WorkTabKey => !!k && (WORK_TAB_KEYS as readonly string[]).includes(k);

/** A tab's address, with its own query (`workHref("tasks", "view=list")`). */
export const workHref = (tab: WorkTabKey, query?: string) => `/app/work/${tab}${query ? `?${query}` : ""}`;

/** The tab a Work address shows: its path (/app/work/calendar), or null on any other page. */
export function workTabOf(path: string): WorkTabKey | null {
  const m = /^\/app\/work\/([a-z]+)\/?$/.exec(path);
  return m && isTab(m[1]) ? m[1] : null;
}

/**
 * Where an old `/app/work?tab=…` link (emails, chat messages, old bookmarks) lands now: the tab's own
 * address, with its other parameters kept. Names of removed sub-tabs become the view they are now
 * (`?tab=projects` → `/app/work/tasks?view=projects`); unknown names open Việc.
 */
export function legacyWorkHref(params: URLSearchParams): string {
  const q = new URLSearchParams(params);
  const raw = q.get("tab") ?? "";
  q.delete("tab");
  const view = SUB_VIEW[raw];
  if (view && !q.has("view")) q.set("view", view);
  const asked = WORK_TAB_ALIAS[raw] ?? raw;
  return workHref(isTab(asked) ? asked : "tasks", q.toString());
}
const SUB_VIEW: Record<string, string> = { projects: "projects", files: "files", meetings: "meetings" };

/** Old and spoken names for a tab (its visible label, removed tabs) that land on a current one. */
export const WORK_TAB_ALIAS: Record<string, string> = {
  kanban: "tasks",
  board: "tasks",
  projects: "tasks",
  lich: "calendar",
  files: "docs",
  approvals: "ops",
  meetings: "calendar",
  requests: "ops",
  "yeu-cau": "ops",
};

/** The tabs that are Việc (its tasks and the company's goals); the sidebar lights "Việc" for either. */
export const TASK_TABS: readonly string[] = ["tasks", "goals"];

/**
 * Tiến độ moved: its overview and team views live on as AI › Tiến độ, a person's page as
 * /app/work/people/:id. Old links and emails (?tab=overview, ?tab=team&u=…) land there.
 */
export const RETIRED_PROGRESS_TABS: readonly string[] = ["overview", "team", "progress", "tien-do", "followup", "theo-doi"];

/**
 * The sub-view tabs of a Work destination (Sự kiện · Cuộc họp, Trang · Tệp; never the destination's own name) for its `PageHeader`, as `Tabs` items.
 * `t` is the client `useT()` or the server `getT()`; keys and URLs are the ones every old link uses.
 */
type SubTabKey = "work.page.events" | "work.page.cuoc_hop" | "docs.switch.pages" | "docs.switch.files";
export function workSubTabs(destination: "calendar" | "docs", tr: (key: SubTabKey) => string): { key: string; label: string; href: string }[] {
  return destination === "calendar"
    ? [
        { key: "calendar", label: tr("work.page.events"), href: "/app/work/calendar" },
        { key: "meetings", label: tr("work.page.cuoc_hop"), href: "/app/work/calendar?view=meetings" },
      ]
    : [
        { key: "pages", label: tr("docs.switch.pages"), href: "/app/work/docs" },
        { key: "files", label: tr("docs.switch.files"), href: "/app/work/docs?view=files" },
      ];
}
