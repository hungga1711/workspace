import type { T } from "@/lib/i18n/core";
export interface Announcement {
  id: string;
  title: string;
  body: string;
  category: string;
  authorId: string;
  departmentIds: string[];
  pinned: boolean;
  eventAt: string | null;
  linkUrl: string | null;
  publishAt: string;
  expiresAt: string | null;
  readAt?: string | null;
  readCount?: number;
}
export const CATEGORY = (tx: T): Record<string, string> => ({
  general: tx("labels.category.general"),
  event: tx("labels.category.event"),
  policy: tx("labels.category.policy"),
  learning: tx("labels.category.learning"),
  wellness: tx("labels.category.wellness"),
  celebration: tx("labels.category.celebration"),
  program: tx("labels.category.program"),
});
