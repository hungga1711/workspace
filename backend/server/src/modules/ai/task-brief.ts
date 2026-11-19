/**
 * The task brief for "Hỏi AI về task": what the model reads before each answer, built from data the
 * asker could open themselves (the work module checks, as them). Pure: the controller gathers, this lays it out in
 * priority order and stops at a character budget, so a long comment thread never pushes the task itself out.
 *
 *   1. the task: title, status, due, blocked reason, progress, description (its checklist included), subtasks,
 *      comments, status history, attachment names
 *   2. its parent, what it waits on and what waits on it, the project and the project's goals
 *   3. documents: named in the task, in its project, found by its words
 *   4. similar finished tasks, who did them and how
 *   5. chat messages that name its code
 *
 * Every line that can be cited starts with [n]; the same n is in `sources`, which the page shows as chips.
 */

export interface BriefTaskDetail {
  task: {
    id: string;
    code: string;
    title: string;
    description: string;
    status: string;
    priority: string;
    dueAt: string | null;
    assigneeId: string | null;
    ownerId: string;
    blockedReason?: string | null;
    progress?: number | null;
    etaAt?: string | null;
    labels?: string[];
    version: number;
    updatedAt?: string;
  };
  comments: { authorId: string; body: string; createdAt: string; editedAt?: string | null }[];
  subtasks: { id: string; code: string; title: string; status: string; assigneeId?: string | null }[];
  activity?: { actor: string; action: string; changes: Record<string, unknown> | null; at: string }[];
  files?: { name: string; contentType?: string }[];
  dependencies?: { waitingOn: { id: string; code: string; title: string; status: string }[]; blocking: { id: string; code: string; title: string; status: string }[] };
}

export interface BriefRelated {
  keywords: string[];
  project: { id: string; code: string; name: string; description: string } | null;
  goals: { goal: string; keyResult: string }[];
  parent: { id: string; code: string; title: string; status: string; description: string } | null;
  docs: { id: string; code: string; title: string; why: string; excerpt: string | null; url: string }[];
  similar: { id: string; code: string; title: string; assigneeId: string | null; completedAt: string | null; how: string | null; subtasks: number }[];
  messages: { id: string; channel: string; body: string; url: string; at: string }[];
}

export interface BriefSource {
  n: number;
  type: "task" | "document" | "message" | "project";
  id: string;
  title: string;
  url: string;
}

export interface Brief {
  text: string;
  sources: BriefSource[];
  /** Sections that did not fit the budget (whole or in part), for tests and logs. */
  cut: string[];
}

type Lang = "en" | "vi";
const L = {
  en: {
    task: "The task",
    status: "Status",
    priority: "Priority",
    due: "Due",
    noDue: "no due date",
    assignee: "Assignee",
    unassigned: "nobody",
    blocked: "Blocked because",
    progress: "Progress reported",
    eta: "expected",
    labels: "Labels",
    description: "Description",
    subtasks: "Subtasks",
    comments: "Comments (oldest first)",
    history: "Status history",
    files: "Attachments (names only)",
    around: "Around the task",
    parent: "Parent task",
    waitsOn: "Waits on",
    blocks: "Blocks",
    project: "Project",
    goal: "Project goal",
    docs: "Documents",
    similar: "Similar finished tasks",
    doneBy: "done by",
    on: "on",
    how: "how",
    subs: "subtasks",
    messages: "Chat messages that mention",
    why: { mentioned: "named in the task", project: "in the project", search: "found by its words" } as Record<string, string>,
  },
  vi: {
    task: "Việc này",
    status: "Trạng thái",
    priority: "Ưu tiên",
    due: "Hạn",
    noDue: "chưa có hạn",
    assignee: "Người làm",
    unassigned: "chưa giao",
    blocked: "Đang bị chặn vì",
    progress: "Tiến độ đã báo",
    eta: "dự kiến xong",
    labels: "Nhãn",
    description: "Mô tả",
    subtasks: "Việc con",
    comments: "Bình luận (cũ trước)",
    history: "Lịch sử trạng thái",
    files: "Tệp đính kèm (chỉ tên)",
    around: "Xung quanh việc này",
    parent: "Việc cha",
    waitsOn: "Chờ",
    blocks: "Đang chặn",
    project: "Dự án",
    goal: "Mục tiêu của dự án",
    docs: "Tài liệu",
    similar: "Việc tương tự đã xong",
    doneBy: "do",
    on: "xong",
    how: "cách làm",
    subs: "việc con",
    messages: "Tin nhắn có nhắc",
    why: { mentioned: "được nhắc trong việc", project: "trong dự án", search: "tìm theo từ khoá" } as Record<string, string>,
  },
};

const oneLine = (s: string) =>
  s
    .replace(/<@(?:agent:)?[\w-]+>/g, "@…")
    .replace(/\s+/g, " ")
    .trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : "");

/** Mentions are stored as <@id>: the model reads names, never ids it could copy into an answer. */
function named(text: string, names: Record<string, string>): string {
  return text.replace(/<@(?:agent:)?([\w-]{1,64})>/g, (_m, id: string) => (names[id] ? `@${names[id]}` : "@…"));
}

export function buildBrief(detail: BriefTaskDetail, related: BriefRelated | null, opts: { budget: number; lang: Lang; names?: Record<string, string> }): Brief {
  const l = L[opts.lang];
  const names = opts.names ?? {};
  const who = (id: string | null | undefined) => (id ? (names[id] ?? "?") : l.unassigned);
  const sources: BriefSource[] = [];
  const cite = (s: Omit<BriefSource, "n">) => {
    const hit = sources.find((x) => x.type === s.type && x.id === s.id);
    if (hit) return hit.n;
    sources.push({ ...s, n: sources.length + 1 });
    return sources.length;
  };
  const t = detail.task;
  const taskN = cite({ type: "task", id: t.id, title: `${t.code} ${t.title}`, url: `/app/work/tasks/${t.id}` });

  // Each section is a list of blocks; a block is added whole, or cut to what is left when it is the first that does not fit.
  const sections: { name: string; blocks: string[] }[] = [];

  // 1. The task itself.
  const head = [
    `## ${l.task} [${taskN}] ${t.code}: ${t.title}`,
    `${l.status}: ${t.status} · ${l.priority}: ${t.priority} · ${l.due}: ${t.dueAt ? day(t.dueAt) : l.noDue} · ${l.assignee}: ${who(t.assigneeId)}`,
    t.blockedReason ? `${l.blocked}: ${oneLine(t.blockedReason)}` : "",
    t.progress != null ? `${l.progress}: ${t.progress}%${t.etaAt ? `, ${l.eta} ${day(t.etaAt)}` : ""}` : "",
    t.labels?.length ? `${l.labels}: ${t.labels.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const one: string[] = [head];
  if (t.description.trim()) one.push(`### ${l.description}\n${clip(named(t.description.trim(), names), 6000)}`);
  if (detail.subtasks.length)
    one.push(
      `### ${l.subtasks}\n${detail.subtasks.map((s) => `- [${s.status === "done" ? "x" : " "}] ${s.code} ${s.title}${s.assigneeId ? ` (${who(s.assigneeId)})` : ""}`).join("\n")}`,
    );
  // The newest comments matter most: kept from the end, shown oldest first.
  const comments = detail.comments.slice(-25).map((c) => `- ${day(c.createdAt)} ${who(c.authorId)}: ${clip(oneLine(named(c.body, names)), 600)}`);
  if (comments.length) one.push(`### ${l.comments}\n${comments.join("\n")}`);
  const moves = (detail.activity ?? [])
    .filter((a) => a.action === "moved" || (a.action === "updated" && a.changes && "status" in a.changes))
    .slice(0, 12)
    .reverse()
    .map((a) => {
      const ch = (a.action === "moved" ? a.changes : (a.changes?.status as Record<string, unknown>)) as { from?: unknown; to?: unknown } | null;
      return `- ${day(a.at)} ${who(a.actor.replace(/^(user|agent|service):/, ""))}: ${String(ch?.from ?? "?")} → ${String(ch?.to ?? "?")}`;
    });
  if (moves.length) one.push(`### ${l.history}\n${moves.join("\n")}`);
  if (detail.files?.length) one.push(`### ${l.files}\n${detail.files.map((f) => `- ${f.name}`).join("\n")}`);
  sections.push({ name: "task", blocks: one });

  if (related) {
    // 2. Around it.
    const two: string[] = [];
    if (related.parent) {
      const n = cite({ type: "task", id: related.parent.id, title: `${related.parent.code} ${related.parent.title}`, url: `/app/work/tasks/${related.parent.id}` });
      two.push(
        `- ${l.parent} [${n}] ${related.parent.code}: ${related.parent.title} (${related.parent.status})${related.parent.description ? `\n  ${clip(oneLine(related.parent.description), 800)}` : ""}`,
      );
    }
    for (const [label, list] of [
      [l.waitsOn, detail.dependencies?.waitingOn ?? []],
      [l.blocks, detail.dependencies?.blocking ?? []],
    ] as const)
      for (const x of list) {
        const n = cite({ type: "task", id: x.id, title: `${x.code} ${x.title}`, url: `/app/work/tasks/${x.id}` });
        two.push(`- ${label} [${n}] ${x.code}: ${x.title} (${x.status})`);
      }
    if (related.project) {
      const n = cite({ type: "project", id: related.project.id, title: related.project.name, url: `/app/work/projects/${related.project.id}` });
      two.push(`- ${l.project} [${n}] ${related.project.name}${related.project.description ? `: ${clip(oneLine(related.project.description), 800)}` : ""}`);
      for (const g of related.goals) two.push(`- ${l.goal}: ${oneLine(g.goal)} · ${oneLine(g.keyResult)}`);
    }
    if (two.length) sections.push({ name: "around", blocks: [`## ${l.around}\n${two.join("\n")}`] });

    // 3. Documents.
    if (related.docs.length) {
      const lines = related.docs.map((d) => {
        const n = cite({ type: "document", id: d.id, title: d.title, url: d.url });
        return `- [${n}] ${d.title}${d.code ? ` (${d.code})` : ""} · ${l.why[d.why] ?? d.why}${d.excerpt ? `: ${clip(oneLine(d.excerpt), 300)}` : ""}`;
      });
      sections.push({ name: "docs", blocks: [`## ${l.docs}\n${lines.join("\n")}`] });
    }

    // 4. Similar finished tasks.
    if (related.similar.length) {
      const lines = related.similar.map((s) => {
        const n = cite({ type: "task", id: s.id, title: `${s.code} ${s.title}`, url: `/app/work/tasks/${s.id}` });
        return `- [${n}] ${s.code}: ${s.title} · ${l.doneBy} ${who(s.assigneeId)}${s.completedAt ? ` · ${l.on} ${day(s.completedAt)}` : ""}${s.subtasks ? ` · ${s.subtasks} ${l.subs}` : ""}${s.how ? `\n  ${l.how}: ${clip(oneLine(named(s.how, names)), 300)}` : ""}`;
      });
      sections.push({ name: "similar", blocks: [`## ${l.similar}\n${lines.join("\n")}`] });
    }

    // 5. Messages.
    if (related.messages.length) {
      const lines = related.messages.map((m) => {
        const n = cite({ type: "message", id: m.id, title: m.channel ? `#${m.channel}` : "message", url: m.url });
        return `- [${n}] ${day(m.at)}${m.channel ? ` #${m.channel}` : ""}: ${clip(oneLine(named(m.body, names)), 300)}`;
      });
      sections.push({ name: "messages", blocks: [`## ${l.messages} ${t.code}\n${lines.join("\n")}`] });
    }
  }

  // Lay out in order until the budget is spent; a block that does not fit is cut (when enough room is left) or dropped.
  let left = opts.budget;
  const out: string[] = [];
  const cut: string[] = [];
  const used = new Set<number>();
  for (const s of sections) {
    for (const b of s.blocks) {
      if (b.length + 2 <= left) {
        out.push(b);
        left -= b.length + 2;
      } else {
        if (!cut.includes(s.name)) cut.push(s.name);
        if (left > 300) {
          out.push(`${b.slice(0, left - 2).trimEnd()}…`);
          left = 0;
        }
      }
    }
  }
  const text = out.join("\n\n");
  // Only sources whose line made it in can be cited.
  for (const m of text.matchAll(/\[(\d+)\]/g)) used.add(Number(m[1]));
  return { text, sources: sources.filter((s) => used.has(s.n)), cut };
}

/**
 * Citations as the page reads them: models sometimes write a source as a Markdown link to its number
 * ("[the runbook](#3)", "[3](#3)") or as "[source 3]"; those become "the runbook [3]".
 */
export function normalizeCitations(answer: string): string {
  return answer
    .replace(/\[(\d+)\]\(#\d+\)/g, "[$1]")
    .replace(/\[([^\]\n]+)\]\(#(\d+)\)/g, "$1 [$2]")
    .replace(/\[(?:source|nguồn)\s+(\d+)\]/gi, "[$1]");
}

/** The source numbers an answer cites ("[2]", "[1][3]", "[2, 4]"), in order of first use, among the known ones. */
export function citedSources(answer: string, sources: BriefSource[]): BriefSource[] {
  const order: number[] = [];
  for (const m of answer.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)) for (const n of m[1]!.split(",").map((x) => Number(x.trim()))) if (!order.includes(n)) order.push(n);
  return order.map((n) => sources.find((s) => s.n === n)).filter((s): s is BriefSource => !!s);
}

/** Task codes written in a question ("@WEB-42", "xem T-041 giúp"), at most `max`, for Hỏi đáp to read those tasks too. */
export function taskCodesIn(text: string, max = 2): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?<![\w/-])@?([A-Z][A-Z0-9]{0,9}-\d{1,6})(?![\w-])/g)) {
    if (!out.includes(m[1]!)) out.push(m[1]!);
    if (out.length === max) break;
  }
  return out;
}

/**
 * What changes the brief: the task's version (fields, status), its comments (added or edited) and the asker. Related
 * data (documents, messages) can change without it; the cache's time limit covers that.
 */
export function briefStamp(detail: BriefTaskDetail): string {
  const lastComment = detail.comments.reduce((m, c) => Math.max(m, Date.parse(c.editedAt ?? c.createdAt) || 0), 0);
  return `${detail.task.version}:${detail.comments.length}:${lastComment}:${detail.subtasks.length}`;
}

/**
 * The built-in (extractive) model's answer from the brief, for the starter questions: no writing, only what is there,
 * so a company without a hosted model still gets a useful reply. null when the question is none of those.
 */
export function localTaskAnswer(question: string, detail: BriefTaskDetail, related: BriefRelated | null, lang: Lang, names: Record<string, string> = {}): string | null {
  const q = question.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").toLowerCase();
  const en = lang === "en";
  const t = detail.task;
  const who = (id: string | null) => (id ? (names[id] ?? "?") : en ? "nobody" : "chưa ai");
  if (/giai thich|explain|what is this|la gi/.test(q)) {
    const first = t.description
      .split("\n")
      .map((x) => x.trim())
      .filter((x) => x && !/^#|^- \[/.test(x))
      .slice(0, 3)
      .join(" ");
    const lines = [
      en
        ? `**${t.code} ${t.title}** is ${t.status.replace("_", " ")}, assigned to ${who(t.assigneeId)}.`
        : `**${t.code} ${t.title}** đang ở trạng thái ${t.status}, người làm: ${who(t.assigneeId)}.`,
      first ? clip(oneLine(first), 600) : "",
      t.blockedReason ? (en ? `It is blocked: ${t.blockedReason}` : `Đang bị chặn: ${t.blockedReason}`) : "",
      related?.parent ? (en ? `Part of ${related.parent.code} ${related.parent.title}.` : `Thuộc ${related.parent.code} ${related.parent.title}.`) : "",
    ];
    return lines.filter(Boolean).join("\n\n");
  }
  if (/buoc|steps?|how do i|lam the nao|bat dau/.test(q)) {
    const listed = [...t.description.matchAll(/^\s*(?:- \[[ x]\]|\d+[.)]|[-*])\s+(.+)$/gm)].map((m) => m[1]!.trim()).slice(0, 8);
    const open = detail.subtasks.filter((s) => s.status !== "done").map((s) => `${s.code} ${s.title}`);
    const steps = listed.length ? listed : open;
    if (!steps.length) return null;
    return `${en ? "Steps from the task:" : "Các bước theo việc này:"}\n${steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`;
  }
  if (/giong|tuong tu|similar|da co ai|done before|lam roi/.test(q)) {
    if (!related?.similar.length) return en ? "I found no finished task like this one that you can see." : "Mình chưa thấy việc tương tự nào đã xong mà bạn có quyền xem.";
    return `${en ? "Finished tasks like this one:" : "Các việc tương tự đã xong:"}\n${related.similar
      .map((s) => `- ${s.code} ${s.title} · ${en ? "by" : "do"} ${who(s.assigneeId)}${s.how ? ` — ${clip(oneLine(s.how), 160)}` : ""}`)
      .join("\n")}`;
  }
  return null;
}
