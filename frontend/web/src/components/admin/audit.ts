import type { MessageKey, T } from "@/lib/i18n/core";

/**
 * Admin › Nhật ký: the audit trail (ADR 0025, `/api/platform/audit`). One row per action anywhere in the workspace,
 * never private content (messages, page text, prompts…). Pure helpers here (shared by the screen, the overview and
 * the CSV export); the UI is AuditView / AuditRows.
 */
export interface TrailEntry {
  id: string;
  at: string;
  actorType: "user" | "agent" | "apikey" | "system" | "anonymous" | string;
  actorId: string;
  via: string | null;
  ip: string | null;
  userAgent: string | null;
  module: string;
  action: string;
  targetType: string;
  targetId: string;
  targetLabel: string | null;
  outcome: "success" | "failure" | "denied" | string;
  requestId: string | null;
  changes: Record<string, unknown>;
  meta: Record<string, unknown>;
}

export interface TrailPage {
  entries: TrailEntry[];
  next: string | null;
}

export interface TrailStats {
  total: number;
  actors: number;
  failures: number;
  modules: { module: string; n: number }[];
}

/** Rows per page on the screen. */
export const TRAIL_PAGE = 50;

export const TRAIL_MODULES = ["identity", "platform", "chat", "work", "employee", "ai"] as const;
export const TRAIL_RANGES = ["1", "7", "30", "90", "all", "custom"] as const;
export const TRAIL_OUTCOMES = ["success", "failure", "denied"] as const;
const ACTOR_TYPES = ["user", "agent", "apikey", "system", "anonymous"] as const;

/** Kinds of action for the filter: an action prefix each (the API matches a prefix ending in "."). */
export const TRAIL_GROUPS = [
  "identity.auth.",
  "identity.account.",
  "identity.member.",
  "identity.role.",
  "identity.team.",
  "identity.agent.",
  "identity.apikey.",
  "identity.mcp.",
  "platform.workspace.",
  "platform.webhook.",
  "platform.audit.",
  "chat.channel.",
  "chat.message.",
  "work.task.",
  "work.project.",
  "work.document.",
  "work.whiteboard.",
  "work.approval.",
  "work.meeting.",
  "work.workflow.",
  "work.file.",
  "work.drive.",
  "employee.leave.",
  "employee.attendance.",
  "employee.profile.",
  "employee.announcement.",
  "ai.connection.",
  "ai.policy.",
  "ai.mcp.",
  "ai.spend.",
] as const;

/** The screen's filter, as held in the URL (shareable trace links). */
export interface TrailFilter {
  range: (typeof TRAIL_RANGES)[number];
  from?: string;
  to?: string;
  actor?: string;
  actorType?: string;
  module?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  q?: string;
  requestId?: string;
  outcome?: string;
}

const SLUG = /^[a-z_.]{1,80}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const clean = (v: string | undefined, max: number) => {
  const s = v?.trim();
  return s && s.length <= max ? s : undefined;
};

/** Reads the filter from search params, dropping anything malformed (a hand-edited URL never errors). */
export function filterFromParams(sp: Record<string, string | string[] | undefined>): TrailFilter {
  const one = (k: string) => {
    const v = sp[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const range = (TRAIL_RANGES as readonly string[]).includes(one("range") ?? "") ? (one("range") as TrailFilter["range"]) : "30";
  const f: TrailFilter = { range };
  if (range === "custom") {
    if (DAY.test(one("from") ?? "")) f.from = one("from");
    if (DAY.test(one("to") ?? "")) f.to = one("to");
  }
  const actor = clean(one("actor"), 64);
  if (actor) f.actor = actor;
  if ((ACTOR_TYPES as readonly string[]).includes(one("actorType") ?? "")) f.actorType = one("actorType");
  if ((TRAIL_MODULES as readonly string[]).includes(one("module") ?? "")) f.module = one("module");
  if (SLUG.test(one("action") ?? "")) f.action = one("action");
  if (SLUG.test(one("targetType") ?? "")) f.targetType = one("targetType");
  const targetId = clean(one("targetId"), 200);
  if (targetId) f.targetId = targetId;
  const q = clean(one("q"), 100);
  if (q) f.q = q;
  if (/^[\w-]{8,64}$/.test(one("requestId") ?? "")) f.requestId = one("requestId");
  if ((TRAIL_OUTCOMES as readonly string[]).includes(one("outcome") ?? "")) f.outcome = one("outcome");
  return f;
}

/** The filter as URL params for the screen (the default 30-day range stays out of the URL). */
export function filterParams(f: TrailFilter): URLSearchParams {
  const q = new URLSearchParams();
  if (f.range !== "30") q.set("range", f.range);
  for (const k of ["from", "to", "actor", "actorType", "module", "action", "targetType", "targetId", "q", "requestId", "outcome"] as const) {
    const v = f[k];
    if (v && (f.range === "custom" || (k !== "from" && k !== "to"))) q.set(k, v);
  }
  return q;
}

export function filterHref(f: TrailFilter, patch: Partial<TrailFilter> = {}): string {
  const merged = { ...f, ...patch } as TrailFilter;
  for (const [k, v] of Object.entries(patch)) if (v === undefined || v === "") delete (merged as unknown as Record<string, unknown>)[k];
  const q = filterParams(merged);
  return `/admin/workspace/audit${q.size ? `?${q}` : ""}`;
}

/** The filter as the API's query (`from` / `to` worked out from the range). `now` for tests. */
export function trailQuery(f: TrailFilter, now = Date.now()): URLSearchParams {
  const q = new URLSearchParams();
  if (f.range === "custom") {
    // Whole days in the viewer's sense of a day is close enough for an admin filter: UTC midnights.
    if (f.from) q.set("from", new Date(`${f.from}T00:00:00Z`).toISOString());
    if (f.to) q.set("to", new Date(Date.parse(`${f.to}T00:00:00Z`) + 86400_000).toISOString());
  } else if (f.range !== "all") q.set("from", new Date(now - Number(f.range) * 86400_000).toISOString());
  for (const k of ["actor", "actorType", "module", "action", "targetType", "targetId", "q", "requestId", "outcome"] as const) {
    const v = f[k];
    if (v) q.set(k, v);
  }
  return q;
}

/** "work.task.status_changed" → "task status changed": what an action without a label reads as. */
export function humanize(code: string): string {
  const parts = code.split(".");
  return (parts.length > 1 ? parts.slice(1) : parts).join(" ").replace(/_/g, " ");
}

/** An action's label: its own (`labels.auditTrail.*`), else the older admin log's label, else the code humanized. */
export function actionLabel(tx: T, code: string): string {
  const key = `labels.auditTrail.${code.replace(/\./g, "_")}`;
  const own = tx(key as MessageKey);
  if (own !== key) return own;
  const m = /^(identity|platform)\.(.+)$/.exec(code);
  if (m) {
    const legacy = `labels.auditAction.${m[2]!.replace(".", "_")}`;
    const old = tx(legacy as MessageKey);
    if (old !== legacy) return old;
  }
  return humanize(code);
}

/** A target type's name ("task" → "công việc"), else the raw type. */
export function targetTypeLabel(tx: T, type: string): string {
  const key = `labels.auditTarget.${type}`;
  const s = tx(key as MessageKey);
  return s === key ? type.replace(/_/g, " ") : s;
}

export function moduleLabel(tx: T, module: string): string {
  const key = `labels.auditModule.${module}`;
  const s = tx(key as MessageKey);
  return s === key ? module : s;
}

export function groupLabel(tx: T, prefix: string): string {
  const key = `labels.auditTrailGroup.${prefix.replace(/\.$/, "").replace(/\./g, "_")}`;
  const s = tx(key as MessageKey);
  return s === key ? humanize(prefix.replace(/\.$/, "")) : s;
}

export type Change =
  | { field: string; kind: "set"; from: unknown; to: unknown }
  | { field: string; kind: "private" }
  | { field: string; kind: "members"; added: string[]; removed: string[] }
  | { field: string; kind: "other"; value: unknown };

/** An entry's `changes` as a list the details table renders (private fields say only that they changed). */
export function changeList(changes: Record<string, unknown> | null | undefined): Change[] {
  return Object.entries(changes ?? {}).map(([field, v]): Change => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      if (o.changed === true && !("from" in o) && !("to" in o)) return { field, kind: "private" };
      if (Array.isArray(o.added) || Array.isArray(o.removed))
        return { field, kind: "members", added: ((o.added as unknown[]) ?? []).map(String), removed: ((o.removed as unknown[]) ?? []).map(String) };
      if ("from" in o || "to" in o) return { field, kind: "set", from: o.from ?? null, to: o.to ?? null };
    }
    return { field, kind: "other", value: v };
  });
}

/** Fields whose values are member ids (shown as names). */
export const PERSON_FIELDS = new Set(["assigneeId", "ownerId", "managerId", "approverId", "requesterId", "delegateId", "userId", "deciderId", "onBehalfOf"]);
/** Fields whose values are moments (shown as dates). */
export const TIME_FIELDS = new Set(["dueAt", "startsAt", "endsAt", "checkIn", "checkOut", "until"]);

/** The one change worth putting in the sentence: "→ Đang làm". */
export function headlineChange(e: TrailEntry): Change | null {
  const list = changeList(e.changes).filter((c) => c.kind === "set");
  return list.length === 1 ? list[0]! : null;
}
