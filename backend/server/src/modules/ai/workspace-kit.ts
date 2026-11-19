import { z } from "zod";
import type { Principal } from "@workspace/shared";
import type { Loc } from "./locale.js";
import { ToolProblem, type Source, type ToolContext, type Tool } from "./tools.js";

/**
 * What every workspace tool file shares: name lookups, task references, dates, and the confirm card's
 * fields. Split out of workspace-tools.ts so the tool files per area (tools-*.ts) build on it without importing the
 * registry that imports them.
 */
export const str = (d: string) => ({ type: "string", description: d });
export const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase().trim();
export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n…` : s);
export const work = <T>(ctx: ToolContext, method: string, path: string, body?: unknown) => ctx.services.work.request<T>(method, path, body, ctx.principal);
export const enc = encodeURIComponent;
export const en = (ctx: ToolContext) => ctx.lang === "en";

export interface Person {
  userId: string;
  displayName: string;
  email?: string | null;
}
/**
 * The people a typed name means, most exact first: the whole name; every word a whole word of the name ("An" is An
 * Phạm, not Lan or Thanh); every word the start of one; every word inside the name. The first tier with anyone wins.
 */
export function matchNames<T extends { displayName: string }>(people: T[], who: string): T[] {
  const q = fold(who);
  const words = q.split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const parts = (e: T) => fold(e.displayName).split(/\s+/);
  const tiers: ((e: T) => boolean)[] = [
    (e) => fold(e.displayName) === q,
    (e) => words.every((w) => parts(e).includes(w)),
    (e) => words.every((w) => parts(e).some((x) => x.startsWith(w))),
    (e) => words.every((w) => fold(e.displayName).includes(w)),
  ];
  for (const t of tiers) {
    const hits = people.filter(t);
    if (hits.length) return hits;
  }
  return [];
}

/** A colleague by id, exact name, email or the one name that matches; a clear error for the model when unsure. */
export async function person(ctx: ToolContext, who: string): Promise<Person> {
  const r = await ctx.services.employee.request<{ employees: Person[] }>("GET", "/employees?all=1", undefined, ctx.principal);
  const q = fold(who);
  // "mình" and "tôi" as written: folded, "mình" would be the name Minh.
  if (["me", "myself", "i", "tôi", "mình"].includes(who.trim().toLowerCase()))
    return r.employees.find((e) => e.userId === ctx.principal.id) ?? { userId: ctx.principal.id, displayName: "me" };
  const exact = r.employees.filter((e) => e.userId === who || (e.email && fold(e.email) === q));
  const hits = exact.length ? exact : matchNames(r.employees, who);
  if (hits.length === 1) return hits[0]!;
  throw new ToolProblem(
    hits.length
      ? `Several people match "${who}": ${hits
          .slice(0, 6)
          .map((e) => e.displayName)
          .join(", ")}. Ask the user which one.`
      : `Nobody in the workspace matches "${who}". Use find_people or ask the user.`,
  );
}

/** The people on an invitation by name, with their answer; an id nobody knows any more is left out. */
export async function namesOf(ctx: ToolContext, attendees: { userId: string; response: string }[]): Promise<string[]> {
  const r = await ctx.services.employee.request<{ employees: Person[] }>("GET", "/employees?all=1", undefined, ctx.principal).catch(() => ({ employees: [] as Person[] }));
  const by = new Map(r.employees.map((e) => [e.userId, e.displayName]));
  return attendees.flatMap((a) => (by.has(a.userId) ? [`${by.get(a.userId)}${a.response && a.response !== "pending" ? ` (${a.response})` : ""}`] : []));
}

/** The one colleague a name means, as the asker sees the directory; null when nobody or several match. */
export async function colleague(services: ToolContext["services"], principal: Principal, name: string): Promise<{ userId: string; displayName: string } | null> {
  return person({ principal, agentId: null, services, lang: "en" }, name).catch(() => null);
}

export interface TaskHead {
  id: string;
  code: string;
  title: string;
  version: number;
  status: string;
}
export const taskOf = async (ctx: ToolContext, ref: string) => (await work<{ task: TaskHead }>(ctx, "GET", `/tasks/${enc(ref.trim())}`)).task;
export const taskSource = (t: { id: string; code: string; title: string }): Source => ({
  type: "task",
  id: t.id,
  title: `${t.code} ${t.title}`,
  url: `/app/work/tasks/${t.code || t.id}`,
});

export const isoDate = z.string().refine((v) => !Number.isNaN(Date.parse(v)), "an ISO date-time with an offset, e.g. 2026-11-14T09:00:00+07:00");
export const when = (iso: string, ctx: ToolContext) =>
  new Date(iso).toLocaleString(en(ctx) ? "en-GB" : "vi-VN", {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: ctx.timeZone ?? "UTC",
  });

/** What a confirm card shows for a write tool: a title in plain words and the fields that matter. */
export interface Preview {
  title: string;
  /** `md`: written text (a description, a comment, a page's words) the card shows as formatted Markdown. */
  fields: { label: string; value: string; md?: true }[];
  note?: string;
}
export type Say = { en: string; vi: string };
export interface Write {
  tool: Tool;
  title: Say;
  preview(input: Record<string, unknown>, loc: Loc): Preview;
}
export const L = (loc: Loc, s: Say) => (loc === "vi" ? s.vi : s.en);
export const field = (loc: Loc, label: Say, value: unknown): Preview["fields"] => {
  if (value === undefined || value === null || value === "") return [];
  const md = WRITTEN.has(label);
  // Written text is shown whole enough to read (cut Markdown mid-table reads worse than a long card).
  const text = clip(Array.isArray(value) ? value.join(", ") : String(value), md ? 4000 : 600);
  return [{ label: L(loc, label), value: text, ...(md ? { md: true as const } : {}) }];
};
export const F = {
  title: { en: "Title", vi: "Tiêu đề" },
  task: { en: "Task", vi: "Việc" },
  details: { en: "Details", vi: "Mô tả" },
  assignee: { en: "Assignee", vi: "Người làm" },
  due: { en: "Due", vi: "Hạn" },
  status: { en: "Status", vi: "Trạng thái" },
  priority: { en: "Priority", vi: "Ưu tiên" },
  comment: { en: "Comment", vi: "Bình luận" },
  starts: { en: "Starts", vi: "Bắt đầu" },
  ends: { en: "Ends", vi: "Kết thúc" },
  people: { en: "Invited", vi: "Mời" },
  place: { en: "Place", vi: "Địa điểm" },
  item: { en: "Meeting or event", vi: "Cuộc họp / sự kiện" },
  page: { en: "Page", vi: "Trang" },
  text: { en: "Text", vi: "Nội dung" },
  find: { en: "Replace this", vi: "Thay đoạn này" },
  withText: { en: "With", vi: "Bằng" },
  workflow: { en: "Workflow", vi: "Workflow" },
  answers: { en: "Answers", vi: "Trả lời" },
  project: { en: "Project", vi: "Dự án" },
  to: { en: "To", vi: "Gửi tới" },
  message: { en: "Message", vi: "Tin nhắn" },
  approver: { en: "Approver", vi: "Người duyệt" },
  amount: { en: "Amount", vi: "Số tiền" },
  kind: { en: "Type", vi: "Loại" },
} satisfies Record<string, Say>;

/** Where a message goes: a channel the user is in, by name, else the direct conversation with the one colleague named. */
export async function destination(ctx: ToolContext, to: string): Promise<{ id: string; label: string }> {
  const q = fold(to.replace(/^[#@]/, ""));
  const r = await ctx.services.chat.request<{ channels: { id: string; kind: string; name: string | null; displayName: string | null }[] }>(
    "GET",
    "/channels",
    undefined,
    ctx.principal,
  );
  const named = r.channels.filter((c) => c.kind !== "dm" && [c.name, c.displayName].some((n) => n && fold(n) === q));
  if (named.length === 1) return { id: named[0]!.id, label: `#${named[0]!.displayName || named[0]!.name}` };
  if (named.length > 1) throw new ToolProblem(`Several channels are called "${to}". Ask the user which one.`);
  let p: Person;
  try {
    p = await person(ctx, to);
  } catch (e) {
    if (e instanceof ToolProblem && e.message.startsWith("Several")) throw e;
    throw new ToolProblem(`"${to}" is neither a channel the user is in nor a colleague. Ask the user where to send it.`);
  }
  if (p.userId === ctx.principal.id) throw new ToolProblem("That is the user themselves. Ask who the message is for.");
  const dm = await ctx.services.chat.request<{ id: string }>("POST", "/dms", { userId: p.userId }, ctx.principal);
  return { id: dm.id, label: p.displayName };
}

/**
 * A date-time as the card shows it: the wall time the model wrote (its offset is the asker's), not the raw ISO text.
 * Anything that is not a date-time is shown as it came.
 */
export function niceTime(v: unknown, loc: Loc): unknown {
  const m = typeof v === "string" ? /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(v) : null;
  if (!m) return v;
  const day = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(day.getTime())) return v;
  const date = day.toLocaleDateString(loc === "vi" ? "vi-VN" : "en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  return m[4] ? `${date}, ${m[4]}:${m[5]}` : date;
}

/** The fields that hold written text, shown as Markdown on the card. */
export const WRITTEN = new Set<Say>([F.details, F.comment, F.text, F.withText, F.message]);

/** Reads that every tool of an answer repeats and that do not change while it runs: the directory, the departments. */
const ANSWER_MEMO = new Set(["/employees?all=1", "/departments"]);

/**
 * The services for one answer, with the directory read once: person(), namesOf() and most area tools each fetch
 * `/employees?all=1` (200 people: 34 KB), and an answer that calls four tools fetched it four to eight times. Only
 * GETs of ANSWER_MEMO, per principal; a failed read is not kept, so the next tool asks again.
 */
export function answerServices(services: ToolContext["services"]): ToolContext["services"] {
  const memo = (client: ToolContext["services"]["employee"]): ToolContext["services"]["employee"] => {
    const kept = new Map<string, Promise<unknown>>();
    const wrapped = Object.create(client) as typeof client;
    wrapped.request = (<T>(method: string, path: string, body?: unknown, as?: Principal, requestId?: string): Promise<T> => {
      if (method !== "GET" || !ANSWER_MEMO.has(path)) return client.request<T>(method, path, body, as, requestId);
      const key = `${as?.id ?? ""} ${path}`;
      const hit = kept.get(key);
      if (hit) return hit as Promise<T>;
      const p = client.request<T>(method, path, body, as, requestId);
      kept.set(key, p);
      p.catch(() => kept.delete(key));
      return p;
    }) as typeof client.request;
    return wrapped;
  };
  return { ...services, employee: memo(services.employee) };
}
