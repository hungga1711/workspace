import type { T } from "@/lib/i18n/core";

/**
 * Work's tabs (/app/work/<key>), grouped into five destinations in the sidebar: Việc (tasks, projects, boards and
 * the company's goals), Tài liệu (pages + files), Bảng trắng (whiteboards), Lịch (calendar + meetings) and Yêu cầu
 * (every request that needs a decision).
 */
export const workTabs = (tx: T) =>
  [
    { key: "tasks", label: tx("work.page.tasks") },
    { key: "goals", label: tx("goals.tab") },
    { key: "docs", label: tx("work.page.tai_lieu") },
    { key: "whiteboards", label: tx("work.page.whiteboards") },
    { key: "calendar", label: tx("work.page.lich") },
    { key: "ops", label: tx("work.page.requests") },
  ] as const;
