import { localDate } from "@/lib/format";

export type DayGroup = "today" | "yesterday" | "week" | "month" | "older";

/** History by recency, as on chatgpt.com: today, yesterday, the last 7 and 30 days, then older. Rows stay newest first. */
export function groupByDay<R extends { lastAt: string }>(rows: R[]): [DayGroup, R[]][] {
  // Calendar days in the workspace's zone, so the server render and the browser agree.
  const today = Date.parse(localDate());
  const groupOf = (at: string): DayGroup => {
    const days = Math.round((today - Date.parse(localDate(at))) / 86_400_000);
    return days <= 0 ? "today" : days === 1 ? "yesterday" : days <= 7 ? "week" : days <= 30 ? "month" : "older";
  };
  const out: [DayGroup, R[]][] = [];
  for (const r of rows) {
    const g = groupOf(r.lastAt);
    if (out.at(-1)?.[0] === g) out.at(-1)![1].push(r);
    else out.push([g, [r]]);
  }
  return out;
}

/**
 * Messages that open a new day, for a separator above them. A thread that stays within one day gets none: the
 * timestamps say enough. Messages without a time (just sent, not saved yet) belong to the day before them.
 */
export function dayBreaks(rows: { id: string; at?: string | undefined }[], tz?: string): Set<string> {
  const out = new Set<string>();
  let prev: string | null = null;
  let first: string | null = null;
  for (const r of rows) {
    if (!r.at) continue;
    const day = localDate(r.at, tz);
    if (prev === null) first = r.id;
    else if (day !== prev) out.add(r.id);
    prev = day;
  }
  if (out.size && first) out.add(first);
  return out;
}

/** Search that ignores case and Vietnamese tone marks ("bao gia" finds "Báo giá"). */
const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();
export const matches = (title: string, q: string) => !q.trim() || fold(title).includes(fold(q.trim()));
