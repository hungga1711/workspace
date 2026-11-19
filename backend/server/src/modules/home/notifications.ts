import { isMsg, renderMsg, type DueAt, type Texts } from "./texts.js";

/**
 * The inbox collapses a burst of the same thing into one line: every approval waiting ("8 approvals waiting"), every
 * comment on one task ("Lily and 3 others commented on T-215"). Rows that share a key form a group while two or more of
 * them are unread; the web app writes the grouped line in the reader's language from the kind, the count, the people
 * (actor ids, named from its directory) and the group's params.
 */
export function groupKeyOf(kind: string, refId: string | null, url: string): string | null {
  switch (kind) {
    case "approval.requested":
    case "leave.requested":
    case "task.assigned":
    case "ai.flagged":
    case "task.due":
    case "meeting.invited":
      return kind;
    case "task.commented":
    case "doc.commented":
      return refId ? `${kind}:${refId}` : null;
    case "task.mention": {
      const task = /\/app\/work\/tasks\/([^/?#]+)/.exec(url)?.[1];
      return task ? `${kind}:${task}` : null;
    }
    case "mention": {
      const channel = /\/app\/chat\/([^/?#]+)/.exec(url)?.[1];
      return channel ? `${kind}:${channel}` : null;
    }
    default:
      return null;
  }
}

export interface NotificationRow {
  id: string;
  grp: "action" | "update";
  kind: string;
  title: string;
  body: string;
  url: string;
  readAt: string | null;
  createdAt: string;
  titleMsg: unknown;
  bodyMsg: unknown;
  actorId: string | null;
  groupKey: string | null;
  params: Record<string, unknown> | null;
  goneAt: string | null;
  refId?: string | null;
}

/** A task's due time now, for due-soon notices: the date in the notice was right when sent, the task may have moved since. */
export interface LiveDue {
  due: DueAt | null;
  done: boolean;
}

export interface Notification {
  id: string;
  grp: "action" | "update";
  kind: string;
  title: string;
  body: string;
  /** Empty when the task or page it was about was deleted (`gone`). */
  url: string;
  readAt: string | null;
  createdAt: string;
  actorId: string | null;
  groupKey: string | null;
  params: Record<string, unknown>;
  gone: boolean;
}

/** One row for the reader: the stored message in their language when there is one, else the text written at the time. */
export function present(t: Texts, r: NotificationRow, live?: Map<string, LiveDue>): Notification {
  let title = (isMsg(r.titleMsg) && renderMsg(t, r.titleMsg)) || r.title;
  const now = r.kind === "task.due" && r.refId ? live?.get(r.refId) : undefined;
  if (now?.due && !now.done && isMsg(r.titleMsg)) {
    const name = String(r.titleMsg.a?.[1] ?? "");
    title = new Date(now.due.at).getTime() < Date.now() ? t.overdue(now.due, name) : t.dueSoon(now.due, name);
  }
  const body = (isMsg(r.bodyMsg) && renderMsg(t, r.bodyMsg)) || r.body;
  return {
    id: r.id,
    grp: r.grp,
    kind: r.kind,
    title,
    body,
    url: r.goneAt ? "" : r.url,
    readAt: r.readAt,
    createdAt: r.createdAt,
    actorId: r.actorId,
    groupKey: r.groupKey,
    params: r.params ?? {},
    gone: !!r.goneAt,
  };
}

export interface Group {
  key: string;
  kind: string;
  /** Unread rows in the group, newest first. */
  ids: string[];
  count: number;
  /** Distinct people who caused them, most recent first. */
  actorIds: string[];
  params: Record<string, unknown>;
  latestAt: string;
}

/** Groups of two or more unread rows sharing a key, in the order of their newest row. */
export function groupsOf(rows: Notification[]): Group[] {
  const by = new Map<string, Group>();
  for (const r of rows) {
    if (!r.groupKey || r.readAt || r.gone) continue;
    let g = by.get(r.groupKey);
    if (!g) {
      g = { key: r.groupKey, kind: r.kind, ids: [], count: 0, actorIds: [], params: r.params, latestAt: r.createdAt };
      by.set(r.groupKey, g);
    }
    g.ids.push(r.id);
    g.count++;
    if (r.actorId && !g.actorIds.includes(r.actorId)) g.actorIds.push(r.actorId);
  }
  return [...by.values()].filter((g) => g.count > 1);
}

export const NOTIFICATION_COLS = `id, grp, kind, title, body, url, read_at AS "readAt", created_at AS "createdAt", title_msg AS "titleMsg", body_msg AS "bodyMsg",
  actor_id AS "actorId", group_key AS "groupKey", params, gone_at AS "goneAt", ref_id AS "refId"`;
