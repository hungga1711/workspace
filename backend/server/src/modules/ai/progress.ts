import type { Loc } from "./locale.js";
import type { Source, ToolResult } from "./tools.js";

/**
 * What an answer is doing while it is written, and what it could not see, from the tool calls themselves:
 * no model call, nothing guessed. Every call of a workspace tool goes through executeTool, which tells the answer's
 * Trace when it starts and ends; the Trace turns that into
 *
 *   steps      one line per call, shown live ("Reading overdue tasks: Engineering…" → "… · 12 items")
 *   notes      what limits the answer: a source that failed, no access to part of it, a short period, nothing found
 *   follow-ups the next questions worth asking, from what was read (a task → its history, a person → their week)
 *
 * The phrases are fixed templates per tool and language. The model is told separately (workspaceRules) to say when it
 * is guessing; the notes here are the facts it may forget to mention.
 */

/** What a result leaves out, said under the answer. Tools add these where they know (team_status: a manager's view). */
export type Coverage = { kind: "scope"; scope: "self" | "reports" | "department" } | { kind: "window"; days: number } | { kind: "truncated"; shown: number; total: number };

/** One call as the browser shows it. `n`: how many items it found, when the result is a list. */
export interface Step {
  id: string;
  tool: string;
  text: string;
  state: "running" | "done" | "failed";
  n?: number;
}

interface Call {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  started: number;
  result?: ToolResult;
}

type Say4 = Record<Loc, string>;
const T = (en: string, vi: string, zh: string, es: string): Say4 => ({ en, vi, zh, es });

/**
 * The phrase for a tool, by language: what it does, without "now" or "done" (the state adds that). A tool not listed
 * reads as its title (workspace-tools TITLES), which every tool has.
 */
const PHRASES: Record<string, Say4> = {
  search_workspace: T("Searching the workspace", "Tìm trong workspace", "搜索工作区", "Buscando en el espacio"),
  read_item: T("Opening", "Mở", "打开", "Abriendo"),
  list_my_tasks: T("Reading your tasks", "Đọc việc của bạn", "读取你的任务", "Leyendo tus tareas"),
  list_calendar: T("Reading the calendar", "Đọc lịch", "读取日历", "Leyendo el calendario"),
  find_people: T("Looking up people", "Tìm người", "查找人员", "Buscando personas"),
  team_status: T("Reading the team's work", "Đọc việc của đội", "读取团队工作", "Leyendo el trabajo del equipo"),
  project_status: T("Reading the project", "Đọc dự án", "读取项目", "Leyendo el proyecto"),
  goals_status: T("Reading the goals", "Đọc mục tiêu", "读取目标", "Leyendo los objetivos"),
  delegated_status: T("Reading what you assigned", "Đọc việc bạn đã giao", "读取你分配的任务", "Leyendo lo que asignaste"),
  who_is_out: T("Checking who is out", "Xem ai nghỉ", "查看谁请假", "Viendo quién está fuera"),
  my_leave_balance: T("Reading your leave", "Đọc ngày phép", "读取你的假期", "Leyendo tus vacaciones"),
  recent_channel_messages: T("Reading the channel", "Đọc kênh", "读取频道", "Leyendo el canal"),
  get_thread: T("Reading the thread", "Đọc chủ đề", "读取话题", "Leyendo el hilo"),
  get_task: T("Reading the task", "Đọc việc", "读取任务", "Leyendo la tarea"),
  search_tasks: T("Searching tasks", "Tìm việc", "搜索任务", "Buscando tareas"),
  search_messages: T("Searching messages", "Tìm tin nhắn", "搜索消息", "Buscando mensajes"),
  search_documents: T("Searching pages", "Tìm trang", "搜索文档", "Buscando páginas"),
  get_document: T("Reading the page", "Đọc trang", "读取文档", "Leyendo la página"),
  team_ai_usage: T("Reading AI use", "Đọc mức dùng AI", "读取 AI 使用情况", "Leyendo el uso de IA"),
  overdue_tasks: T("Reading overdue tasks", "Đọc việc trễ hạn", "读取逾期任务", "Leyendo tareas atrasadas"),
  task_history: T("Reading the task's history", "Đọc lịch sử việc", "读取任务历史", "Leyendo el historial"),
  estimate_due_date: T("Estimating from similar tasks", "Ước tính từ việc tương tự", "根据类似任务估算", "Estimando con tareas similares"),
  find_duplicate_tasks: T("Looking for duplicates", "Tìm việc trùng", "查找重复任务", "Buscando duplicados"),
  summarize_channel: T("Reading the conversation", "Đọc cuộc trò chuyện", "读取对话", "Leyendo la conversación"),
  extract_action_items: T("Reading the conversation", "Đọc cuộc trò chuyện", "读取对话", "Leyendo la conversación"),
  unanswered_questions: T("Finding unanswered questions", "Tìm câu hỏi chưa trả lời", "查找未回复的问题", "Buscando preguntas sin responder"),
  draft_reply: T("Reading the thread", "Đọc chủ đề", "读取话题", "Leyendo el hilo"),
  needs_my_attention: T("Gathering what waits for you", "Gom việc đang chờ bạn", "汇总等你处理的事项", "Reuniendo lo que te espera"),
  person_progress: T("Reading their week", "Đọc tuần làm việc", "读取本周进展", "Leyendo su semana"),
  department_compare: T("Comparing departments", "So sánh các phòng", "比较部门", "Comparando departamentos"),
  workload_balance: T("Weighing workloads", "Cân khối lượng việc", "衡量工作量", "Midiendo la carga"),
  blockers_report: T("Reading blocked work", "Đọc việc bị chặn", "读取受阻工作", "Leyendo el trabajo bloqueado"),
  trend_metric: T("Reading the trend", "Đọc xu hướng", "读取趋势", "Leyendo la tendencia"),
  weekly_report_text: T("Building the weekly report", "Lập báo cáo tuần", "生成周报", "Preparando el informe semanal"),
  ai_usage_vs_output: T("Comparing AI use and output", "So sánh dùng AI và kết quả", "比较 AI 使用与产出", "Comparando uso de IA y resultados"),
  prompt_topics: T("Reading AI topics", "Đọc chủ đề dùng AI", "读取 AI 话题", "Leyendo temas de IA"),
  ai_spend: T("Reading AI spend", "Đọc chi phí AI", "读取 AI 费用", "Leyendo el gasto en IA"),
  summarize_document: T("Reading the page", "Đọc trang", "读取文档", "Leyendo la página"),
  compare_document_versions: T("Comparing versions", "So sánh phiên bản", "比较版本", "Comparando versiones"),
  workflow_run_status: T("Reading workflow runs", "Đọc lần chạy workflow", "读取工作流运行", "Leyendo ejecuciones"),
  find_meeting_slot: T("Finding a free time", "Tìm giờ trống", "查找空闲时间", "Buscando un hueco"),
  attendance_summary: T("Reading attendance", "Đọc chấm công", "读取考勤", "Leyendo la asistencia"),
  org_chart: T("Reading the org chart", "Đọc sơ đồ tổ chức", "读取组织架构", "Leyendo el organigrama"),
  who_reports_to: T("Reading reporting lines", "Đọc tuyến báo cáo", "读取汇报关系", "Leyendo la jerarquía"),
  plan_my_day: T("Planning your day", "Lên kế hoạch ngày", "规划你的一天", "Planificando tu día"),
  draft_update: T("Gathering your day's work", "Gom việc trong ngày", "汇总今天的工作", "Reuniendo tu trabajo de hoy"),
  // The connected AI's own web and cloud tools (web-need.ts), and the workspace's own page reader.
  web_search: T("Searching the web", "Đang tìm trên web", "搜索网络", "Buscando en la web"),
  web_fetch: T("Reading the page", "Đang đọc trang", "读取网页", "Leyendo la página"),
  read_webpage: T("Reading the page", "Đang đọc trang", "读取网页", "Leyendo la página"),
  code_execution: T("Running code on the data", "Đang chạy code trên dữ liệu", "对数据运行代码", "Ejecutando código con los datos"),
};

/** The input that names what a call is about ("Engineering", "T-041", "budget"), shown after the phrase. */
const SUBJECT_KEYS = ["query", "task", "person", "who", "department", "project", "page", "channel", "title", "subject", "name", "url"];
function subjectOf(input: Record<string, unknown>): string {
  for (const k of SUBJECT_KEYS) {
    const v = input[k];
    // Ids are for tools, never for people (01H…, a long hex): a name or a code only.
    if (typeof v === "string" && v.trim() && !/^[0-9A-HJKMNP-TV-Z]{26}$|^[0-9a-f-]{20,}$/i.test(v.trim())) {
      const s = v.trim().replace(/\s+/g, " ");
      if (k === "url") return siteOf(s).slice(0, 48);
      return k === "query" ? `“${s.slice(0, 40)}”` : s.slice(0, 40);
    }
  }
  return "";
}

/** A web address as people read it: the site and path, no scheme or "www.". */
export function siteOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, "")}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return url;
  }
}

/** How many items a result lists: its lines that look like entries. 0 when it says there is nothing. */
export function countOf(content: string): number | undefined {
  if (nothingFound(content)) return 0;
  const lines = content.split("\n").filter((l) => /^\s*(?:[-*•]\s|\d+[.)]\s|\[[^\]]{1,40}\]\s|[A-Z]{1,6}-\d+\b|\|[^|-])/.test(l));
  // A table counts its rows, not its header and rule.
  const table = content.split("\n").filter((l) => /^\s*\|/.test(l) && !/^\s*\|\s*:?-{2,}/.test(l)).length;
  const n = Math.max(lines.length - (table ? Math.min(table, 1) : 0), 0);
  return n > 0 ? n : undefined;
}

const NOTHING =
  /^\s*(?:\[[^\]]{1,30}\]\s*)?(?:nothing|no (?:matching|results|tasks|one|messages|questions|pages|data|runs|items)|none\b|không (?:có|tìm thấy)|chưa có (?:việc|dữ liệu|gì)|没有|sin resultados|no hay)/i;
export const nothingFound = (content: string) => NOTHING.test(content.trim());

const SUFFIX = {
  items: T("{n} items", "{n} mục", "{n} 项", "{n} elementos"),
  none: T("nothing found", "không thấy gì", "未找到", "nada encontrado"),
  failed: T("could not read", "không đọc được", "无法读取", "no se pudo leer"),
  denied: T("no access", "không có quyền", "无权限", "sin acceso"),
  cached: T("just read", "vừa đọc", "刚读取", "recién leído"),
};

export function stepText(tool: string, input: Record<string, unknown>, loc: Loc, title: string, result?: ToolResult): { text: string; n?: number } {
  const phrase = PHRASES[tool]?.[loc] ?? title;
  const subject = subjectOf(input);
  const head = `${phrase}${subject ? `: ${subject}` : ""}`;
  if (!result) return { text: `${head}…` };
  if (!result.ok) return { text: `${head} · ${SUFFIX[result.content.startsWith("DENIED") ? "denied" : "failed"][loc]}` };
  const n = countOf(result.content);
  if (n === 0) return { text: `${head} · ${SUFFIX.none[loc]}`, n: 0 };
  return n ? { text: `${head} · ${SUFFIX.items[loc].replace("{n}", String(n))}`, n } : { text: head };
}

/**
 * One answer's tool calls. `emit` gets every change of a step (the stream's `step` event); `titleOf` names a tool that
 * has no phrase of its own.
 */
export class Trace {
  private calls: Call[] = [];
  private seq = 0;
  /** Facts noted outside a tool call (an answer built from the team's data before any tool ran). */
  private extra: { tool: string; result: ToolResult }[] = [];
  constructor(
    readonly loc: Loc,
    private readonly titleOf: (tool: string, loc: Loc) => string,
    private readonly emit?: (s: Step) => void,
  ) {}

  start(tool: string, input: unknown): string {
    const id = `s${++this.seq}`;
    const call: Call = { id, tool, input: (input && typeof input === "object" ? input : {}) as Record<string, unknown>, started: Date.now() };
    this.calls.push(call);
    this.emit?.(this.view(call));
    return id;
  }

  end(id: string, result: ToolResult): void {
    const call = this.calls.find((c) => c.id === id);
    if (!call) return;
    call.result = result;
    this.emit?.(this.view(call));
  }

  /** A read made without executeTool (answerLate reads the team itself): counted for notes and follow-ups, not shown. */
  noteRead(tool: string, result: ToolResult): void {
    this.extra.push({ tool, result });
  }

  private view(c: Call): Step {
    const { text, n } = stepText(c.tool, c.input, this.loc, this.titleOf(c.tool, this.loc), c.result);
    return { id: c.id, tool: c.tool, text, state: !c.result ? "running" : c.result.ok ? "done" : "failed", ...(n !== undefined ? { n } : {}) };
  }

  /** Every call, as it ended (a call still running when the answer ends reads as failed). */
  steps(): Step[] {
    return this.calls.map((c) => this.view(c.result ? c : { ...c, result: { ok: false, content: "", sources: [] } }));
  }

  /** The tools used, with what they were asked and returned, in order. */
  used(): { tool: string; input: Record<string, unknown>; result: ToolResult }[] {
    return [
      ...this.extra.map((x) => ({ tool: x.tool, input: {}, result: x.result })),
      ...this.calls.filter((c) => c.result).map((c) => ({ tool: c.tool, input: c.input, result: c.result! })),
    ];
  }

  notes(): string[] {
    return coverageNotes(this.used(), this.loc);
  }
}

const NOTE = {
  denied: T(
    "Part of this is not visible to you, so it is left out.",
    "Một phần dữ liệu bạn không có quyền xem nên không có trong câu trả lời.",
    "部分数据你无权查看，未包含在回答中。",
    "Parte de los datos no es visible para ti y no se incluye.",
  ),
  failed: T(
    "{n} source could not be read: the answer may be incomplete.",
    "{n} nguồn không đọc được: câu trả lời có thể thiếu.",
    "{n} 个来源无法读取：回答可能不完整。",
    "{n} fuente no se pudo leer: la respuesta puede estar incompleta.",
  ),
  nothing: T(
    "Nothing in the workspace matched: anything beyond that is not from your data.",
    "Không tìm thấy dữ liệu khớp trong workspace: phần còn lại không lấy từ dữ liệu của bạn.",
    "工作区中没有匹配的数据：其余内容并非来自你的数据。",
    "Nada en el espacio coincidió: lo demás no viene de tus datos.",
  ),
  reports: T("Only the people who report to you are counted.", "Chỉ tính những người báo cáo cho bạn.", "只统计向你汇报的人。", "Solo cuentan las personas a tu cargo."),
  self: T("Only your own work is counted.", "Chỉ tính việc của chính bạn.", "只统计你自己的工作。", "Solo cuenta tu propio trabajo."),
  department: T("Only your department is counted.", "Chỉ tính phòng của bạn.", "只统计你的部门。", "Solo cuenta tu departamento."),
  window: T("Based on the last {n} days of data.", "Dựa trên dữ liệu {n} ngày gần nhất.", "基于最近 {n} 天的数据。", "Basado en los últimos {n} días de datos."),
  truncated: T(
    "Showing {shown} of {total}: the list was cut.",
    "Chỉ hiện {shown}/{total} mục: danh sách đã bị cắt bớt.",
    "仅显示 {total} 项中的 {shown} 项。",
    "Se muestran {shown} de {total}: la lista se recortó.",
  ),
};

/** The limits of an answer, from the calls it made. At most three, most important first. */
export function coverageNotes(used: { tool: string; result: ToolResult }[], loc: Loc): string[] {
  if (!used.length) return [];
  const out: string[] = [];
  const denied = used.filter((u) => !u.result.ok && u.result.content.startsWith("DENIED") && !/invalid tool input|unknown tool/.test(u.result.content));
  const failed = used.filter((u) => !u.result.ok && !u.result.content.startsWith("DENIED") && !u.result.content.startsWith("Refused"));
  if (denied.length) out.push(NOTE.denied[loc]);
  if (failed.length) out.push(NOTE.failed[loc].replace("{n}", String(failed.length)));
  const reads = used.filter((u) => u.result.ok);
  // Every read came back empty: whatever the answer adds is not from the workspace.
  if (reads.length && reads.every((u) => nothingFound(u.result.content))) out.push(NOTE.nothing[loc]);
  const seen = new Set<string>();
  for (const c of reads.flatMap((u) => u.result.coverage ?? [])) {
    const key = c.kind === "scope" ? `scope:${c.scope}` : c.kind;
    if (seen.has(key)) continue;
    seen.add(key);
    if (c.kind === "scope") out.push(NOTE[c.scope][loc]);
    else if (c.kind === "window") out.push(NOTE.window[loc].replace("{n}", String(c.days)));
    else out.push(NOTE.truncated[loc].replace("{shown}", String(c.shown)).replace("{total}", String(c.total)));
  }
  return out.slice(0, 3);
}

// ---------------------------------------------------------------- follow-up questions

const ASK = {
  history: T("What changed on {x}?", "{x} đã thay đổi gì?", "{x} 有哪些变更？", "¿Qué cambió en {x}?"),
  estimate: T("When will {x} be done?", "Khi nào {x} xong?", "{x} 什么时候能完成？", "¿Cuándo estará lista {x}?"),
  split: T("Break {x} into smaller tasks", "Tách {x} thành việc nhỏ", "把 {x} 拆成小任务", "Divide {x} en tareas más pequeñas"),
  person: T("What did {x} finish this week?", "{x} tuần này làm xong gì?", "{x} 本周完成了什么？", "¿Qué terminó {x} esta semana?"),
  project: T("What is late in {x}?", "Dự án {x} có việc nào trễ?", "{x} 有哪些逾期任务？", "¿Qué va con retraso en {x}?"),
  summarizePage: T("Summarise {x}", "Tóm tắt trang {x}", "总结 {x}", "Resume {x}"),
  pageTasks: T("Turn {x} into tasks", "Biến trang {x} thành việc", "把 {x} 变成任务", "Convierte {x} en tareas"),
  overloaded: T("Who is overloaded?", "Ai đang quá tải?", "谁的工作量过大？", "¿Quién está sobrecargado?"),
  blocked: T("What is blocked?", "Việc nào đang bị chặn?", "哪些工作受阻？", "¿Qué está bloqueado?"),
  lastWeek: T("Compare with last week", "So với tuần trước thế nào?", "和上周比怎么样？", "Compara con la semana pasada"),
  actions: T("List the action items here", "Rút việc cần làm từ cuộc trò chuyện này", "列出这里的待办事项", "Lista las tareas pendientes de aquí"),
  unanswered: T("Which questions are still unanswered?", "Câu hỏi nào chưa được trả lời?", "哪些问题还没回复？", "¿Qué preguntas siguen sin respuesta?"),
  plan: T("What should I do first today?", "Hôm nay tôi nên làm gì trước?", "我今天应该先做什么？", "¿Qué debería hacer primero hoy?"),
  eod: T("Write my end-of-day report", "Viết báo cáo cuối ngày của tôi", "写我的日报", "Escribe mi informe de fin de día"),
  slot: T("Find a free hour today", "Tìm giờ trống hôm nay", "找今天的空闲时间", "Busca una hora libre hoy"),
  attention: T("What is waiting for me?", "Việc gì đang chờ tôi?", "有什么在等我处理？", "¿Qué me está esperando?"),
  overdue: T("Which tasks are overdue?", "Việc nào đang trễ hạn?", "哪些任务逾期了？", "¿Qué tareas están atrasadas?"),
  aiOutput: T("Does AI use go with more done?", "Dùng AI có đi cùng làm được nhiều hơn không?", "使用 AI 是否带来更多产出？", "¿El uso de IA va con más resultados?"),
};

/**
 * Up to three questions to ask next, from what this answer read: the items it cited first (a task, a person, a
 * project, a page), then the tools it used. Only questions whose tools this person is offered (`offered`); never the
 * question just asked.
 */
export function followUps(
  question: string,
  used: { tool: string }[],
  sources: Source[],
  loc: Loc,
  offered: (tool: string) => boolean,
  surface: "ask" | "channel" | "task" = "ask",
): string[] {
  const out: string[] = [];
  const add = (key: keyof typeof ASK, need: string, x = "") => {
    if (!offered(need)) return;
    const q = ASK[key][loc].replace("{x}", x);
    if (!out.includes(q)) out.push(q);
  };
  const task = sources.find((s) => s.type === "task");
  const code = task ? (/^[A-Z][A-Z0-9]{0,5}-\d+/.exec(task.title)?.[0] ?? "") : "";
  const person = sources.find((s) => s.type === "employee");
  const project = sources.find((s) => s.type === "project");
  const page = sources.find((s) => s.type === "document");
  const tools = new Set(used.map((u) => u.tool));
  const has = (...names: string[]) => names.some((n) => tools.has(n));

  if (code) {
    add("history", "task_history", code);
    add("estimate", "estimate_due_date", code);
    if (surface === "task") add("split", "split_task", code);
  }
  if (person && has("team_status", "person_progress", "workload_balance", "overdue_tasks", "find_people")) add("person", "person_progress", person.title.slice(0, 40));
  if (project) add("project", "overdue_tasks", project.title.slice(0, 40));
  if (page && has("search_workspace", "read_item", "search_documents", "get_document", "summarize_document")) {
    if (!has("summarize_document")) add("summarizePage", "summarize_document", `“${page.title.slice(0, 40)}”`);
    add("pageTasks", "doc_to_tasks", `“${page.title.slice(0, 40)}”`);
  }
  if (has("team_status", "overdue_tasks", "person_progress", "department_compare")) {
    if (!has("workload_balance")) add("overloaded", "workload_balance");
    if (!has("blockers_report")) add("blocked", "blockers_report");
  }
  if (has("workload_balance") && !has("overdue_tasks")) add("overdue", "overdue_tasks");
  if (has("weekly_report_text", "trend_metric", "department_compare")) add("lastWeek", "trend_metric");
  if (has("summarize_channel", "recent_channel_messages", "get_thread")) {
    if (!has("extract_action_items")) add("actions", "extract_action_items");
    if (!has("unanswered_questions")) add("unanswered", "unanswered_questions");
  }
  if (has("list_my_tasks", "needs_my_attention") && !has("plan_my_day")) add("plan", "plan_my_day");
  if (has("plan_my_day", "list_my_tasks")) add("eod", "draft_update");
  if (has("plan_my_day", "list_calendar")) add("slot", "find_meeting_slot");
  if (has("team_ai_usage", "ai_spend", "prompt_topics") && !has("ai_usage_vs_output")) add("aiOutput", "ai_usage_vs_output");
  if (!out.length && has("search_workspace", "search_tasks", "search_messages")) add("attention", "needs_my_attention");
  const asked = fold(question);
  return out.filter((q) => fold(q) !== asked).slice(0, 3);
}

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
