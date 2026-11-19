/**
 * Pure helpers behind the assistant's content tools (tools-content.ts): a page's sections, a line diff between two
 * versions, CSV in and out, and the task import plan (CSV from Jira, Trello, Asana, ClickUp, Notion or a spreadsheet,
 * and Trello's JSON export). The web app's import dialog has its own copy (components/work/importTasks.ts): modules
 * and the web app share no code, and the server must read the same exports when the AI imports for a person.
 */

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .trim();

// ---- sections ----

export interface Section {
  heading: string;
  level: number;
  text: string;
}

const entities = (s: string) =>
  s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

/** HTML as Markdown-ish text: headings as #, list items as -, block ends as line breaks, every other tag dropped. */
export function htmlToText(html: string): string {
  return entities(
    html
      .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
      .replace(/<h([1-6])[^>]*>/gi, (_m, n: string) => `\n${"#".repeat(Number(n))} `)
      .replace(/<li[^>]*>/gi, "\n- ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|h[1-6]|li|tr|div|blockquote|pre|ul|ol|table)>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A page split at its headings (Markdown `#`…`######`); text before the first heading is a section with no heading. */
export function sectionsOf(content: string, format: "markdown" | "html" | string): Section[] {
  const text = format === "html" ? htmlToText(content) : content;
  const out: Section[] = [];
  let cur: Section = { heading: "", level: 0, text: "" };
  let fence = false;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) fence = !fence;
    const h = fence ? null : /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      if (cur.heading || cur.text.trim()) out.push({ ...cur, text: cur.text.trim() });
      cur = { heading: h[2]!.trim(), level: h[1]!.length, text: "" };
    } else cur.text += `${line}\n`;
  }
  if (cur.heading || cur.text.trim()) out.push({ ...cur, text: cur.text.trim() });
  return out;
}

/**
 * A page for the model to summarize: whole when it fits, else its outline (every heading with its size) and the
 * sections in order until `budget` characters, each cut to its share. Says what was left out.
 */
export function pageDigest(sections: Section[], budget = 24_000): string {
  const whole = sections.map((s) => `${s.heading ? `${"#".repeat(s.level)} ${s.heading}\n` : ""}${s.text}`).join("\n\n");
  if (whole.length <= budget) return whole;
  const outline = sections
    .filter((s) => s.heading)
    .map((s) => `${"  ".repeat(Math.max(0, s.level - 1))}- ${s.heading} (${s.text.length} chars)`)
    .join("\n");
  const share = Math.max(400, Math.floor((budget - outline.length) / Math.max(1, sections.length)));
  const parts = sections.map(
    (s) => `${s.heading ? `${"#".repeat(s.level)} ${s.heading}\n` : ""}${s.text.length > share ? `${s.text.slice(0, share)}\n… (${s.text.length - share} more chars)` : s.text}`,
  );
  return `Outline:\n${outline}\n\nSections (long ones cut):\n${parts.join("\n\n")}`.slice(0, budget + 2000);
}

// ---- line diff ----

export interface DiffLine {
  op: " " | "+" | "-";
  text: string;
}

/**
 * Line-level diff (longest common subsequence). Pages past `max` lines on either side compare their changed middle
 * only: the common head and tail are trimmed first, which keeps a typical edit cheap.
 */
export function lineDiff(a: string, b: string, max = 3000): DiffLine[] {
  const A = a.split("\n");
  const B = b.split("\n");
  let head = 0;
  while (head < A.length && head < B.length && A[head] === B[head]) head++;
  let tail = 0;
  while (tail < A.length - head && tail < B.length - head && A[A.length - 1 - tail] === B[B.length - 1 - tail]) tail++;
  const a2 = A.slice(head, A.length - tail);
  const b2 = B.slice(head, B.length - tail);
  const mid: DiffLine[] = [];
  if (a2.length > max || b2.length > max) {
    // Too large to align: everything in the middle as removed then added.
    for (const t of a2) mid.push({ op: "-", text: t });
    for (const t of b2) mid.push({ op: "+", text: t });
  } else {
    const n = a2.length;
    const m = b2.length;
    const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i]![j] = a2[i] === b2[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a2[i] === b2[j]) {
        mid.push({ op: " ", text: a2[i]! });
        i++;
        j++;
      } else if (L[i + 1]![j]! >= L[i]![j + 1]!) mid.push({ op: "-", text: a2[i++]! });
      else mid.push({ op: "+", text: b2[j++]! });
    }
    while (i < n) mid.push({ op: "-", text: a2[i++]! });
    while (j < m) mid.push({ op: "+", text: b2[j++]! });
  }
  return [...A.slice(0, head).map((t) => ({ op: " " as const, text: t })), ...mid, ...A.slice(A.length - tail).map((t) => ({ op: " " as const, text: t }))];
}

/** A diff as unified-style text: changed lines with `context` unchanged lines around them, gaps as "…". */
export function diffText(lines: DiffLine[], context = 2, maxChars = 20_000): { text: string; added: number; removed: number } {
  const keep = new Set<number>();
  lines.forEach((l, i) => {
    if (l.op !== " ") for (let k = i - context; k <= i + context; k++) keep.add(k);
  });
  const out: string[] = [];
  let gap = false;
  lines.forEach((l, i) => {
    if (!keep.has(i)) {
      if (!gap && out.length) out.push("…");
      gap = true;
      return;
    }
    gap = false;
    out.push(`${l.op} ${l.text}`);
  });
  const text = out.join("\n");
  return {
    text: text.length > maxChars ? `${text.slice(0, maxChars)}\n… (diff cut)` : text,
    added: lines.filter((l) => l.op === "+").length,
    removed: lines.filter((l) => l.op === "-").length,
  };
}

// ---- CSV ----

/** RFC 4180 CSV (quoted cells, doubled quotes, CRLF or LF, a leading BOM); ";"-separated files too. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, "");
  const nl = src.indexOf("\n");
  const firstLine = nl >= 0 ? src.slice(0, nl) : src;
  const sep = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === sep) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((c) => c !== "")) rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c !== "")) rows.push(row);
  return rows;
}

/** One CSV cell: quoted when needed, quotes doubled, spreadsheet formulas neutralised (CSV injection). */
export function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : v instanceof Date ? v.toISOString() : typeof v === "string" ? v : String(v);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r;]/.test(safe) || safe !== s ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export const toCsv = (header: string[], rows: unknown[][]) => [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n");

// ---- task import ----

export type ImportStatus = "todo" | "in_progress" | "review" | "done";
export type ImportPriority = "low" | "medium" | "high" | "urgent";
export type ImportSystem = "jira" | "trello" | "asana" | "clickup" | "notion" | "csv";
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
  parentKey: string | null;
}
export interface ImportPlan {
  system: ImportSystem;
  tasks: ImportTask[];
  skipped: number;
  unknownPeople: string[];
}
export interface Directory {
  userId: string;
  displayName: string;
  email?: string | null;
}

type Field = "title" | "description" | "status" | "priority" | "assignee" | "due" | "labels" | "key" | "parent";
const HEADERS: Record<Field, string[]> = {
  title: ["summary", "title", "name", "task name", "card name", "task", "tieu de", "ten viec", "cong viec"],
  description: ["description", "desc", "notes", "card description", "task content", "details", "mo ta", "noi dung"],
  status: ["status", "list name", "list", "section/column", "section", "column", "state", "trang thai"],
  priority: ["priority", "uu tien", "muc uu tien"],
  assignee: ["assignee", "assignees", "assignee email", "assigned to", "assign", "members", "owner", "person", "nguoi lam", "nguoi phu trach"],
  due: ["due date", "due", "due on", "deadline", "date", "han", "han chot", "ngay het han"],
  labels: ["labels", "label", "tags", "tag", "nhan"],
  key: ["issue key", "key", "card id", "task id", "id", "ma"],
  parent: ["parent id", "parent task id", "parent"],
};

function detectSystem(headers: string[]): ImportSystem {
  const h = headers.map(fold);
  if (h.includes("issue key") || h.includes("issue type")) return "jira";
  if (h.includes("task name") && (h.includes("task id") || h.includes("space name") || h.includes("list name"))) return "clickup";
  if (h.includes("card name") || h.includes("list name")) return "trello";
  if (h.includes("section/column") || h.includes("parent task")) return "asana";
  return "csv";
}

export function mapStatus(v: string): ImportStatus {
  const s = fold(v);
  if (/^(not started|to ?do|backlog|open|chua bat dau)/.test(s)) return "todo";
  if (/^(done|closed|resolved|complete|completed|finished|xong|hoan thanh|da xong)/.test(s)) return "done";
  if (/(review|qa|testing|kiem thu|cho duyet)/.test(s)) return "review";
  if (/(progress|doing|dang lam|in dev|development|started|wip)/.test(s)) return "in_progress";
  return "todo";
}

export function mapPriority(v: string): ImportPriority {
  const s = fold(v);
  if (/(highest|critical|blocker|urgent|khan|p0)/.test(s)) return "urgent";
  if (/(high|cao|p1)/.test(s)) return "high";
  if (/(low|lowest|thap|p3|p4)/.test(s)) return "low";
  return "medium";
}

/** ISO, dd/mm/yyyy (mm/dd when `monthFirst`), Jira's "15/Oct/26", epoch ms, and what Date understands; 10:00 UTC for a bare day. */
export function parseDue(v: string, monthFirst = false): string | null {
  const s = (v.includes("→") ? v.split("→").pop()! : v).trim();
  if (!s) return null;
  if (/^\d{11,13}$/.test(s)) return new Date(Number(s)).toISOString();
  const jira = /^(\d{1,2})\/([A-Za-z]{3})\/(\d{2})/.exec(s);
  if (jira) {
    const m = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(jira[2]!.toLowerCase());
    if (m >= 0) return new Date(Date.UTC(2000 + Number(jira[3]), m, Number(jira[1]), 10)).toISOString();
  }
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/.exec(s);
  if (dmy) {
    const y = Number(dmy[3]!.length === 2 ? `20${dmy[3]}` : dmy[3]);
    const [day, month] = monthFirst ? [dmy[2], dmy[1]] : [dmy[1], dmy[2]];
    const d = new Date(Date.UTC(y, Number(month) - 1, Number(day), 10));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T10:00:00.000Z`;
  const t = Date.parse(s.replace(/^[A-Za-z]+,\s*/, "").replace(/(\d)(st|nd|rd|th)\b/, "$1"));
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  return /\d:\d/.test(s) ? d.toISOString() : new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), 10)).toISOString();
}

const listCell = (v: string) =>
  v
    .replace(/^\[(.*)\]$/s, "$1")
    .split(/[,;]/)
    .map((x) => x.trim())
    .filter(Boolean);

/** Name or email → user id; email wins (it is unique), then the one exact name. */
function matcher(people: Directory[]) {
  const by = new Map<string, string | null>();
  for (const p of people) {
    if (p.email) by.set(fold(p.email), p.userId);
    const n = fold(p.displayName);
    // Two people with one name: nobody, rather than the wrong one.
    by.set(n, by.has(n) && by.get(n) !== p.userId ? null : p.userId);
  }
  return (who: string) => (who ? (by.get(fold(who)) ?? null) : null);
}

/** Subtasks one level deep: a sub-subtask hangs from its top-level ancestor; a parent not in the import is dropped. */
function flattenParents(tasks: ImportTask[]): ImportTask[] {
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

/** Trello's JSON export (cards, lists, members). */
function planTrelloJson(data: unknown, people: Directory[]): ImportPlan | null {
  const d = data as {
    lists?: { id: string; name: string }[];
    cards?: { name?: string; desc?: string; due?: string | null; idList?: string; closed?: boolean; labels?: { name: string }[]; idMembers?: string[]; idShort?: number }[];
    members?: { id: string; fullName?: string; username?: string }[];
  };
  if (!Array.isArray(d?.cards) || !Array.isArray(d.lists)) return null;
  const listName = new Map(d.lists.map((l) => [l.id, l.name]));
  const member = new Map((d.members ?? []).map((m) => [m.id, m.fullName || m.username || ""]));
  const match = matcher(people);
  const unknown = new Set<string>();
  let skipped = 0;
  const tasks: ImportTask[] = [];
  for (const card of d.cards) {
    const title = (card.name ?? "").trim();
    if (!title) {
      skipped++;
      continue;
    }
    const who = member.get(card.idMembers?.[0] ?? "") ?? "";
    const assigneeId = match(who);
    if (who && !assigneeId) unknown.add(who);
    tasks.push({
      title: title.slice(0, 300),
      description: (card.desc ?? "").slice(0, 20000),
      status: card.closed ? "done" : mapStatus(listName.get(card.idList ?? "") ?? ""),
      priority: "medium",
      assigneeId,
      assigneeLabel: who || null,
      dueAt: card.due ? parseDue(card.due) : null,
      labels: (card.labels ?? [])
        .map((l) => l.name.trim().slice(0, 40))
        .filter(Boolean)
        .slice(0, 20),
      key: card.idShort ? `#${card.idShort}` : null,
      parentKey: null,
    });
  }
  return { system: "trello", tasks, skipped, unknownPeople: [...unknown] };
}

/** An export (CSV of any of these tools, or Trello's JSON) as tasks, people matched by email then name. */
export function planImport(text: string, people: Directory[]): ImportPlan {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      const plan = planTrelloJson(JSON.parse(trimmed), people);
      if (plan) return plan;
    } catch {
      // Not JSON after all: read it as CSV.
    }
  }
  const rows = parseCsv(text);
  const headers = rows[0] ?? [];
  const folded = headers.map(fold);
  const system = detectSystem(headers);
  const col: Partial<Record<Field, number>> = {};
  for (const f of Object.keys(HEADERS) as Field[]) {
    const names = system === "clickup" && f === "status" ? ["status"] : HEADERS[f];
    const i = names.map((h) => folded.indexOf(h)).find((x) => x >= 0);
    if (i !== undefined) col[f] = i;
  }
  const match = matcher(people);
  const unknown = new Set<string>();
  let skipped = 0;
  const cell = (r: string[], f: Field) => (col[f] === undefined ? "" : (r[col[f]!] ?? "").trim());
  const tasks: ImportTask[] = [];
  for (const r of rows.slice(1)) {
    const title = cell(r, "title");
    if (!title) {
      skipped++;
      continue;
    }
    const who = listCell(cell(r, "assignee"))[0] ?? "";
    const assigneeId = match(who);
    if (who && !assigneeId) unknown.add(who);
    tasks.push({
      title: title.slice(0, 300),
      description: cell(r, "description").slice(0, 20000),
      status: mapStatus(cell(r, "status")),
      priority: mapPriority(cell(r, "priority")),
      assigneeId,
      assigneeLabel: who || null,
      dueAt: parseDue(cell(r, "due"), system === "clickup"),
      labels: listCell(cell(r, "labels"))
        .map((x) => x.slice(0, 40))
        .slice(0, 20),
      key: cell(r, "key").slice(0, 80) || null,
      parentKey: cell(r, "parent").slice(0, 80) || null,
    });
  }
  return { system, tasks: flattenParents(tasks), skipped, unknownPeople: [...unknown] };
}
