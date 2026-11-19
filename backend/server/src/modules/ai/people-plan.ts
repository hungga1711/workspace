/**
 * The pure parts of the people tools (tools-people.ts): free meeting slots from busy times and working hours, and the
 * reporting tree from the directory. No I/O, so they are tested on their own.
 */

export interface Interval {
  start: number;
  end: number;
}

/** "YYYY-MM-DD" + "HH:MM" as wall time in `tz`, to an instant (ms). Two passes settle a DST edge. */
export function zonedInstant(day: string, hm: string, tz: string): number {
  const [y, mo, d] = day.split("-").map(Number) as [number, number, number];
  const [h, mi] = hm.split(":").map(Number) as [number, number];
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let t = wall;
  for (let i = 0; i < 2; i++) t = wall - offsetMs(t, tz);
  return t;
}

/** The zone's UTC offset at an instant, in ms. */
function offsetMs(at: number, tz: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(new Date(at))
      .map((x) => [x.type, x.value]),
  );
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) - Math.floor(at / 1000) * 1000;
}

export const dayIn = (at: number, tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));

/** Busy intervals sorted and joined where they touch or overlap. */
export function merge(busy: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const b of [...busy].filter((x) => x.end > x.start).sort((a, b) => a.start - b.start)) {
    const last = out.at(-1);
    if (last && b.start <= last.end) last.end = Math.max(last.end, b.end);
    else out.push({ ...b });
  }
  return out;
}

export interface SlotQuery {
  from: number;
  to: number;
  tz: string;
  durationMin: number;
  /** ISO weekdays, 1 = Monday … 7 = Sunday. */
  workWeek: readonly number[];
  dayStart: string;
  dayEnd: string;
  /** Company holidays and days someone invited is away (approved leave), YYYY-MM-DD. */
  closedDays: ReadonlySet<string>;
  busy: Interval[];
  now: number;
  max?: number;
}

const STEP = 15 * 60_000;

/**
 * Free windows long enough for the meeting, within working hours on working days, after now, in [from, to]. Each window
 * starts on a quarter hour. At most two per day so a long range offers choice across days, not one morning's gaps.
 */
export function freeSlots(q: SlotQuery): Interval[] {
  const need = q.durationMin * 60_000;
  const busy = merge(q.busy);
  const out: Interval[] = [];
  const max = q.max ?? 8;
  const lo = Math.max(q.from, q.now);
  const last = dayIn(q.to, q.tz);
  for (let day = dayIn(lo, q.tz), guard = 0; day <= last && guard < 62 && out.length < max; day = nextDay(day), guard++) {
    const iso = new Date(`${day}T00:00:00Z`).getUTCDay() || 7;
    if (!q.workWeek.includes(iso) || q.closedDays.has(day)) continue;
    const open = Math.max(zonedInstant(day, q.dayStart, q.tz), lo);
    const close = Math.min(zonedInstant(day, q.dayEnd, q.tz), q.to);
    let cursor = Math.ceil(open / STEP) * STEP;
    let perDay = 0;
    for (const b of [...busy.filter((x) => x.end > cursor && x.start < close), { start: close, end: close }]) {
      const end = Math.min(b.start, close);
      if (end - cursor >= need) {
        out.push({ start: cursor, end });
        if (++perDay === 2 || out.length === max) break;
      }
      cursor = Math.max(cursor, Math.ceil(b.end / STEP) * STEP);
      if (cursor >= close) break;
    }
  }
  return out;
}

const nextDay = (day: string) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

export interface OrgPerson {
  userId: string;
  displayName: string;
  title?: string | null;
  department?: string | null;
  managerId: string | null;
}

/** The manager chain above a person, nearest first; stops on a loop in a bad chart. */
export function managerChain(people: OrgPerson[], userId: string): OrgPerson[] {
  const by = new Map(people.map((p) => [p.userId, p]));
  const chain: OrgPerson[] = [];
  const seen = new Set([userId]);
  for (let m = by.get(userId)?.managerId; m && !seen.has(m) && by.has(m); m = by.get(m)!.managerId) {
    seen.add(m);
    chain.push(by.get(m)!);
  }
  return chain;
}

export const directReports = (people: OrgPerson[], userId: string) => people.filter((p) => p.managerId === userId).sort((a, b) => a.displayName.localeCompare(b.displayName));

/**
 * The reporting tree as indented lines ("  - Name, Title (Department)"). Roots are the given people; children are
 * their direct reports, down to `depth` levels, capped at `limit` lines with a count of what was left out.
 */
export function treeLines(people: OrgPerson[], roots: OrgPerson[], depth = 4, limit = 120): string[] {
  const kids = new Map<string, OrgPerson[]>();
  for (const p of people) if (p.managerId) kids.set(p.managerId, [...(kids.get(p.managerId) ?? []), p]);
  for (const list of kids.values()) list.sort((a, b) => a.displayName.localeCompare(b.displayName));
  const lines: string[] = [];
  let left = 0;
  const seen = new Set<string>();
  const walk = (p: OrgPerson, level: number) => {
    if (seen.has(p.userId)) return;
    seen.add(p.userId);
    if (lines.length >= limit) {
      left++;
      return;
    }
    const under = kids.get(p.userId) ?? [];
    const label = `${p.displayName}${p.title ? `, ${p.title}` : ""}${p.department ? ` (${p.department})` : ""}`;
    lines.push(`${"  ".repeat(level)}- ${label}${level + 1 >= depth && under.length ? ` [+${under.length} more]` : ""}`);
    if (level + 1 < depth) for (const k of under) walk(k, level + 1);
  };
  for (const r of roots) walk(r, 0);
  if (left) lines.push(`… ${left} more people`);
  return lines;
}

/** Top of the company: active people nobody manages (or whose manager is not in the directory). */
export const tops = (people: OrgPerson[]) => {
  const ids = new Set(people.map((p) => p.userId));
  return people.filter((p) => !p.managerId || !ids.has(p.managerId)).sort((a, b) => a.displayName.localeCompare(b.displayName));
};
