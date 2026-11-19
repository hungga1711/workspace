import { fold } from "@/lib/fold";
import { parseCsv } from "@/lib/csv";

export type ImportStatus = "todo" | "in_progress" | "review" | "done";
export type ImportPriority = "low" | "medium" | "high" | "urgent";
export interface ImportTask {
  title: string;
  description: string;
  status: ImportStatus;
  priority: ImportPriority;
  assigneeId: string | null;
  assigneeLabel: string | null;
  dueAt: string | null;
  labels: string[];
  key: string | null;
  /** Source key of the parent task (ClickUp subtasks), resolved by the server within the same import. */
  parentKey: string | null;
  /** The list the task sat in (ClickUp): offered as "one project per list". */
  group: string | null;
}
export type Field = "title" | "description" | "status" | "priority" | "assignee" | "due" | "labels" | "key" | "parent" | "group";
/** Fields a person can re-map by hand in the import dialog, in display order. */
export const MAPPABLE: Field[] = ["title", "status", "assignee", "due", "priority", "labels", "description"];
export type ImportSystem = "jira" | "trello" | "asana" | "clickup" | "notion" | "csv";
export interface ImportPlan {
  system: ImportSystem;
  columns: Partial<Record<Field, number>>;
  headers: string[];
  tasks: ImportTask[];
  skipped: number;
  unknownPeople: string[];
}

/** Folds case and Vietnamese accents so "Tiêu đề", "TIEU DE" and "tieu de" compare equal. */
export const foldKey = (s: string) => fold(s).trim();

// Header names used by Jira, Trello (CSV export), Asana, Linear, ClickUp, Notion databases and spreadsheets,
// Vietnamese included.
const HEADERS: Record<Field, string[]> = {
  title: ["summary", "title", "name", "task name", "card name", "task", "tieu de", "ten viec", "cong viec"],
  description: ["description", "desc", "notes", "card description", "task content", "details", "mo ta", "noi dung"],
  status: ["status", "list name", "list", "section/column", "section", "column", "state", "trang thai"],
  priority: ["priority", "uu tien", "muc uu tien"],
  assignee: ["assignee", "assignees", "assignee email", "assigned to", "assign", "members", "owner", "person", "nguoi lam", "nguoi phu trach"],
  due: ["due date", "due", "due on", "deadline", "date", "han", "han chot", "ngay het han"],
  labels: ["labels", "label", "tags", "tag", "nhan"],
  key: ["issue key", "key", "card id", "task id", "id", "ma"],
  parent: ["parent id", "parent task id"],
  group: [],
};

function detectSystem(headers: string[]): ImportSystem {
  const h = headers.map(foldKey);
  if (h.includes("issue key") || h.includes("issue type")) return "jira";
  // ClickUp's CSV names its columns "Task ID", "Task Name", "Task Content" and carries the space/folder/list.
  if (h.includes("task name") && (h.includes("task id") || h.includes("space name") || h.includes("list name"))) return "clickup";
  if (h.includes("card name") || h.includes("list name")) return "trello";
  if (h.includes("section/column") || h.includes("parent task")) return "asana";
  return "csv";
}

/** ClickUp writes lists as "[a, b]"; everyone else as "a, b" or "a; b". */
const listCell = (v: string) =>
  v
    .replace(/^\[(.*)\]$/s, "$1")
    .split(/[,;]/)
    .map((x) => x.trim())
    .filter(Boolean);

export function mapStatus(v: string): ImportStatus {
  const s = foldKey(v);
  // Notion's default first column; it would otherwise match "started" below.
  if (/^(not started|to ?do|backlog|open|chua bat dau)/.test(s)) return "todo";
  if (/^(done|closed|resolved|complete|completed|finished|xong|hoan thanh|da xong)/.test(s)) return "done";
  if (/(review|qa|testing|kiem thu|cho duyet)/.test(s)) return "review";
  if (/(progress|doing|dang lam|in dev|development|started|wip)/.test(s)) return "in_progress";
  return "todo";
}

export function mapPriority(v: string): ImportPriority {
  const s = foldKey(v);
  if (/(highest|critical|blocker|urgent|khan|p0)/.test(s)) return "urgent";
  if (/(high|cao|p1)/.test(s)) return "high";
  if (/(low|lowest|thap|p3|p4)/.test(s)) return "low";
  return "medium";
}

/**
 * ISO 8601, yyyy-mm-dd, dd/mm/yyyy (Vietnamese order; mm/dd/yyyy when `monthFirst`, as ClickUp writes), Jira's
 * "15/Oct/26 10:00 AM", epoch milliseconds (ClickUp's API), "Friday, October 25th 2026" and anything Date understands.
 */
export function parseDue(v: string, monthFirst = false): string | null {
  // A Notion date range "October 1, 2026 → October 25, 2026": the end is when it is due.
  const s = (v.includes("→") ? v.split("→").pop()! : v).trim();
  if (!s) return null;
  if (/^\d{11,13}$/.test(s)) return new Date(Number(s)).toISOString();
  const vn = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/.exec(s);
  if (vn) {
    const y = Number(vn[3]!.length === 2 ? `20${vn[3]}` : vn[3]);
    const [day, month] = monthFirst ? [vn[2], vn[1]] : [vn[1], vn[2]];
    const d = new Date(Date.UTC(y, Number(month) - 1, Number(day), 10));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const jira = /^(\d{1,2})\/([A-Za-z]{3})\/(\d{2})/.exec(s);
  if (jira) {
    const m = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(jira[2]!.toLowerCase());
    if (m >= 0) return new Date(Date.UTC(2000 + Number(jira[3]), m, Number(jira[1]), 10)).toISOString();
  }
  const t = Date.parse(s.replace(/^[A-Za-z]+,\s*/, "").replace(/(\d)(st|nd|rd|th)\b/, "$1"));
  if (Number.isNaN(t)) return null;
  // A day without a time ("October 30, 2026") parses as local midnight, the day before in UTC east of Greenwich:
  // keep the calendar day, at 10:00 UTC like the other formats above.
  const d = new Date(t);
  return /\d:\d/.test(s) || /^\d{4}-\d{2}-\d{2}$/.test(s) ? d.toISOString() : new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), 10)).toISOString();
}

/**
 * Trello's own export ("Menu › More › Print and export › Export as JSON"): cards with their list, labels, members,
 * due date and archive state. Members are matched by full name or username against the directory.
 */
export function planTrelloJson(text: string, people: { userId: string; displayName: string; email: string }[]): ImportPlan | null {
  let data: {
    lists?: { id: string; name: string; closed?: boolean }[];
    cards?: {
      name: string;
      desc?: string;
      due?: string | null;
      idList: string;
      closed?: boolean;
      labels?: { name: string }[];
      idMembers?: string[];
      idShort?: number;
      shortLink?: string;
    }[];
    members?: { id: string; fullName?: string; username?: string }[];
  };
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(data.cards) || !Array.isArray(data.lists)) return null;
  const listName = new Map(data.lists.map((l) => [l.id, l.name]));
  const byKey = new Map<string, string>();
  for (const p of people) {
    byKey.set(foldKey(p.email), p.userId);
    byKey.set(foldKey(p.displayName), p.userId);
  }
  const member = new Map((data.members ?? []).map((m) => [m.id, m.fullName || m.username || ""]));
  const unknown = new Set<string>();
  let skipped = 0;
  const tasks: ImportTask[] = [];
  for (const card of data.cards) {
    const title = (card.name ?? "").trim();
    if (!title) {
      skipped++;
      continue;
    }
    const who = member.get(card.idMembers?.[0] ?? "") ?? "";
    const assigneeId = who ? (byKey.get(foldKey(who)) ?? null) : null;
    if (who && !assigneeId) unknown.add(who);
    tasks.push({
      title: title.slice(0, 300),
      description: (card.desc ?? "").slice(0, 20000),
      // An archived card is finished; otherwise the list name says where it stands.
      status: card.closed ? "done" : mapStatus(listName.get(card.idList) ?? ""),
      priority: "medium",
      assigneeId,
      assigneeLabel: who || null,
      dueAt: card.due ? parseDue(card.due) : null,
      labels: (card.labels ?? [])
        .map((l) => l.name.trim().slice(0, 40))
        .filter(Boolean)
        .slice(0, 20),
      key: card.idShort ? `#${card.idShort}` : (card.shortLink ?? null),
      parentKey: null,
      group: null,
    });
  }
  return { system: "trello", columns: { title: 0 }, headers: [], tasks, skipped, unknownPeople: [...unknown] };
}

/**
 * workspace subtasks go one level deep: a sub-subtask hangs from its top-level ancestor, and a subtask whose parent is
 * not part of the import stays at the top level.
 */
export function flattenParents(tasks: ImportTask[]): ImportTask[] {
  const parentOf = new Map(tasks.filter((t) => t.key).map((t) => [t.key!, t.parentKey]));
  for (const t of tasks) {
    let p = t.parentKey;
    const seen = new Set<string>();
    while (p && parentOf.get(p) && !seen.has(p)) {
      seen.add(p);
      p = parentOf.get(p)!;
    }
    t.parentKey = p && parentOf.has(p) && p !== t.key ? p : null;
  }
  return tasks;
}

/**
 * ClickUp's JSON (the tasks of a list as its API returns them, `{ tasks: [...] }`): status, priority, assignees by
 * email, due date in epoch milliseconds, tags, the parent of a subtask and the list. People are matched by email,
 * then by username.
 */
export function planClickUpJson(text: string, people: { userId: string; displayName: string; email: string }[]): ImportPlan | null {
  let data: {
    tasks?: {
      id?: string;
      custom_id?: string | null;
      name?: string;
      text_content?: string | null;
      description?: string | null;
      status?: { status?: string; type?: string } | null;
      priority?: { priority?: string } | null;
      assignees?: { email?: string; username?: string }[];
      due_date?: string | number | null;
      tags?: { name: string }[];
      parent?: string | null;
      list?: { name?: string } | null;
    }[];
  };
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(data.tasks)) return null;
  const byKey = new Map<string, string>();
  for (const p of people) {
    if (p.email) byKey.set(foldKey(p.email), p.userId);
    byKey.set(foldKey(p.displayName), p.userId);
  }
  const unknown = new Set<string>();
  let skipped = 0;
  const tasks: ImportTask[] = [];
  for (const x of data.tasks) {
    const title = (x.name ?? "").trim();
    if (!title) {
      skipped++;
      continue;
    }
    const a = x.assignees?.[0];
    const who = a?.email || a?.username || "";
    const assigneeId = (a?.email && byKey.get(foldKey(a.email))) || (a?.username && byKey.get(foldKey(a.username))) || null;
    if (who && !assigneeId) unknown.add(who);
    tasks.push({
      title: title.slice(0, 300),
      description: (x.text_content ?? x.description ?? "").slice(0, 20000),
      // ClickUp's status type says "closed" for whatever a workspace calls its finished column.
      status: x.status?.type === "closed" || x.status?.type === "done" ? "done" : mapStatus(x.status?.status ?? ""),
      priority: mapPriority(x.priority?.priority ?? ""),
      assigneeId,
      assigneeLabel: who || null,
      dueAt: x.due_date ? parseDue(String(x.due_date), true) : null,
      labels: (x.tags ?? [])
        .map((t) => t.name.trim().slice(0, 40))
        .filter(Boolean)
        .slice(0, 20),
      key: (x.custom_id || x.id || "").slice(0, 80) || null,
      parentKey: x.parent ? x.parent.slice(0, 80) : null,
      group: x.list?.name?.slice(0, 120) || null,
    });
  }
  // Subtasks point at the parent's id; when the parent is known by its custom id, follow it there.
  const custom = new Map(data.tasks.filter((x) => x.id && x.custom_id).map((x) => [x.id!, x.custom_id!]));
  for (const t of tasks) if (t.parentKey && custom.has(t.parentKey)) t.parentKey = custom.get(t.parentKey)!;
  return { system: "clickup", columns: { title: 0 }, headers: [], tasks: flattenParents(tasks), skipped, unknownPeople: [...unknown] };
}

/**
 * Reads a CSV export and maps it onto tasks; people are matched by email or name against the directory. Columns are
 * guessed from the headers; `opts.columns` (the dialog's manual mapping, -1 = none) wins over the guess, and
 * `opts.system` names the source when the caller knows it (a Notion database).
 */
export function planImport(
  text: string,
  people: { userId: string; displayName: string; email: string }[],
  opts: { columns?: Partial<Record<Field, number>>; system?: ImportSystem } = {},
): ImportPlan {
  const rows = parseCsv(text);
  const headers = rows[0] ?? [];
  const folded = headers.map(foldKey);
  const system = opts.system ?? detectSystem(headers);
  const columns: ImportPlan["columns"] = {};
  for (const f of Object.keys(HEADERS) as Field[]) {
    // In ClickUp the list is where a task lives (a project), not its status.
    const names = system === "clickup" && f === "status" ? ["status"] : HEADERS[f];
    const i = names.map((h) => folded.indexOf(h)).find((x) => x >= 0);
    if (i !== undefined) columns[f] = i;
  }
  if (system === "clickup" && folded.includes("list name")) columns.group = folded.indexOf("list name");
  for (const [f, i] of Object.entries(opts.columns ?? {}) as [Field, number][]) {
    if (i < 0 || i >= headers.length) delete columns[f];
    else columns[f] = i;
  }
  const monthFirst = system === "clickup";
  const byKey = new Map<string, string>();
  for (const p of people) {
    byKey.set(foldKey(p.email), p.userId);
    byKey.set(foldKey(p.displayName), p.userId);
  }
  const unknown = new Set<string>();
  let skipped = 0;
  const cell = (r: string[], f: Field) => (columns[f] === undefined ? "" : (r[columns[f]!] ?? "").trim());
  const tasks: ImportTask[] = [];
  for (const r of rows.slice(1)) {
    const title = cell(r, "title");
    if (!title) {
      skipped++;
      continue;
    }
    // Trello, Asana and ClickUp may list several people; the first one becomes the assignee.
    const who = listCell(cell(r, "assignee"))[0] ?? "";
    const assigneeId = who ? (byKey.get(foldKey(who)) ?? null) : null;
    if (who && !assigneeId) unknown.add(who);
    tasks.push({
      title: title.slice(0, 300),
      description: cell(r, "description").slice(0, 20000),
      status: mapStatus(cell(r, "status")),
      priority: mapPriority(cell(r, "priority")),
      assigneeId,
      assigneeLabel: who || null,
      dueAt: parseDue(cell(r, "due"), monthFirst),
      labels: listCell(cell(r, "labels"))
        .map((x) => x.slice(0, 40))
        .slice(0, 20),
      key: cell(r, "key").slice(0, 80) || null,
      parentKey: cell(r, "parent").slice(0, 80) || null,
      group: cell(r, "group").slice(0, 120) || null,
    });
  }
  return { system, columns, headers, tasks: flattenParents(tasks), skipped, unknownPeople: [...unknown] };
}
