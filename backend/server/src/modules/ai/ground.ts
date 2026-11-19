import type { Principal } from "@workspace/shared";
import type { ToolContext, Source } from "./tools.js";
import { say, type Loc } from "./locale.js";

/**
 * Answers the boss's most common questions ("who is late", "what is <person> late on", "… in Engineering") straight
 * from the follow-up data, without a model: the names and task codes are the real ones, the answer is instant, and it
 * works with no AI connection or a small self-hosted model that would otherwise make a team up.
 */

export interface LateIntent {
  person?: string;
  department?: string;
}

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase().trim();

/** Department words in Chinese, Spanish and Vietnamese, to the English names companies use ("销售" → Sales). */
const DEPT_ALIAS: [RegExp, string][] = [
  [/^(销售|销售部|ventas|comercial|kinh doanh|bán hàng)$/, "sales"],
  [/^(工程|工程部|研发|技术|技术部|ingenieria|desarrollo|ky thuat|cong nghe)$/, "engineering"],
  [/^(市场|市场部|营销|mercadotecnia|mercadeo|tiep thi)$/, "marketing"],
  [/^(财务|财务部|finanzas|contabilidad|tai chinh|ke toan)$/, "finance"],
  [/^(人事|人力|人力资源|recursos humanos|rrhh|nhan su)$/, "people"],
  [/^(产品|producto|san pham)$/, "product"],
  [/^(设计|diseno|thiet ke)$/, "design"],
  [/^(客服|客户成功|atencion al cliente|exito del cliente|cham soc khach hang)$/, "customer success"],
  [/^(法务|legal|juridico|phap che)$/, "legal"],
];

/** Whether a department name matches what was asked, in any of the four languages. */
export function deptMatches(department: string, asked: string): boolean {
  const d = fold(department);
  const w = fold(asked);
  if (d.includes(w) || w.includes(d)) return true;
  const alias = DEPT_ALIAS.find(([re]) => re.test(w))?.[1];
  return !!alias && (d.includes(alias) || alias.includes(d));
}

/** Words that name a group, not a person ("ai đang trễ", "who is late", "đội mình trễ việc nào"). */
const NOT_A_PERSON =
  /^(ai|những ai|người nào|nhân viên nào|bạn nào|ai nào|ai đó|mọi người|cả đội|đội|team|nhóm|tôi|mình|em|anh|chị|bạn|who|anyone|everyone|someone|my team|the team|we|i)$/i;

/** A trailing "ở/trong/của phòng X", "in X", "X team" after a late question: the department to narrow to. */
function departmentIn(q: string): string | undefined {
  const m =
    /(?:^|\s)(?:ở|trong|của|tại|thuộc)\s+(?:phòng(?:\s+ban)?|bộ phận|nhóm|team|đội)?\s*([A-ZÀ-Ỹa-zà-ỹ0-9&][\p{L}\p{N}& .-]{1,40}?)\s*(?:tuần này|hôm nay|tháng này)?\s*\??\s*$/u.exec(
      q,
    ) ?? /\b(?:in|from|on)\s+(?:the\s+)?([A-Z][\p{L}\p{N}& .-]{1,40}?)(?:\s+(?:team|department|dept))?\s*(?:this week|today)?\s*\??\s*$/u.exec(q);
  const zh = /([\p{L}\p{N}&]{2,20}?)(?:部门|部|团队|组)/u.exec(q)?.[1];
  const es = /\b(?:en|del|de)\s+(?:el\s+)?(?:equipo|departamento|área)\s+(?:de\s+)?([\p{L}\p{N}&][\p{L}\p{N}& .-]{1,40}?)\s*(?:esta semana|hoy)?\s*\??\s*$/iu.exec(q)?.[1];
  const d = (m?.[1] ?? zh ?? es)?.trim();
  if (!d || /^(việc|task|hạn|tuần|ngày|time|hôm|this|哪些|谁|有)\b/i.test(d)) return undefined;
  return d;
}

/** "Tessa Byrne đang trễ những việc nào?", "ai đang trễ việc ở Engineering?", "who is late in Sales?", "what is Liam late on?" */
export function lateIntent(question: string): LateIntent | null {
  const q = question.trim().replace(/^@ai\s+/i, "");
  const lower = q.toLowerCase();
  const late = /(trễ|chậm|quá hạn|trễ hạn|\blate\b|overdue|behind|逾期|延期|超期|拖延|落后|迟了|retrasad|atrasad|vencid|\btarde\b)/.test(lower);
  if (!late) return null;
  // Questions about AI use, projects or goals are other intents ("dự án nào trễ" is the project tool's).
  if (/(dự án|project|mục tiêu|goal|okr|\bai\b.{0,10}(dùng|use)|chatgpt|项目|目标|proyecto|objetivo)/.test(lower) && !/việc|task|任务|tarea/.test(lower)) return null;
  const person =
    /^(.{2,40}?)\s+(?:đang\s+|bị\s+|có\s+)?(?:trễ|chậm|quá hạn)(?:\s+hạn)?\s+(?:những\s+|các\s+|mấy\s+)?(?:việc|task|gì|cái)/iu.exec(q)?.[1] ??
    /(?:việc|task)\s+(?:nào\s+)?(?:trễ|quá hạn|chậm)(?:\s+hạn)?\s+của\s+([^?]{2,40}?)\s*\??$/iu.exec(q)?.[1] ??
    /^[Ww]hat (?:is|are) ([A-Z][^?]{1,39}?) (?:late|behind|overdue) (?:on|with)\b/u.exec(q)?.[1] ??
    /^(?:[Ww]hich|[Ww]hat) tasks? (?:is|are) ([A-Z][^?]{1,39}?) (?:late|behind|overdue)/u.exec(q)?.[1] ??
    /^([A-Z][^?']{1,39}?)['’]s (?:late|overdue) (?:tasks|work)/u.exec(q)?.[1] ??
    // 中文: "张伟有哪些逾期任务？", "Tessa Byrne 有哪些任务逾期了"
    /^(?!谁|哪些)([\p{L} .·]{2,40}?)\s*(?:有|的)(?:哪些|什么|几个|多少)?(?:逾期|延期|超期)?(?:的)?任务/u.exec(q)?.[1] ??
    // Español: "¿Qué tareas tiene Tessa Byrne atrasadas?", "¿Tessa Byrne tiene tareas atrasadas?"
    /tareas?\s+(?:tiene|lleva)\s+([A-ZÁÉÍÓÚÑ][\p{L} .'-]{1,39}?)\s+(?:atrasad|retrasad|vencid)/u.exec(q)?.[1] ??
    /^¿?\s*([A-ZÁÉÍÓÚÑ][\p{L} .'-]{1,39}?)\s+(?:tiene|lleva)\s+tareas?\s+(?:atrasad|retrasad|vencid)/u.exec(q)?.[1];
  const department = departmentIn(q);
  const who = person?.trim().replace(/^(?:hỏi|cho (?:tôi|mình) biết)\s+/i, "");
  if (who && !NOT_A_PERSON.test(who) && !/^(quién|quiénes|alguien|el equipo|mi equipo)$/i.test(who) && !/[谁哪]|大家|团队|部门|员工/.test(who)) return { person: who };
  const group =
    /(\bai\b|những ai|người nào|ai đang|mọi người|đội|team|nhóm|phòng|who|anyone|which people|nhân viên|谁|哪些人|哪位|团队|部门|员工|quién|quiénes|equipo|departamento|alguien|empleados)/i.test(
      lower,
    );
  return group ? { ...(department ? { department } : {}) } : null;
}

interface FollowTask {
  id: string;
  code: string;
  title: string;
  status: string;
  dueAt: string | null;
  overdue?: boolean;
  blockedReason?: string | null;
}
interface FollowPerson {
  userId: string;
  displayName: string;
  title?: string | null;
  department?: string | null;
  overdue: number;
  open: number;
  tasks?: FollowTask[];
  late?: FollowTask[];
  now?: FollowTask[];
}
interface FollowTeam {
  scope: "reports" | "everyone" | "none";
  people: FollowPerson[];
}

/** "25/10" in the workspace zone (written out: ICU builds differ on the separator). */
const dm = (iso: string | null, timeZone?: string) => {
  if (!iso) return "";
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "2-digit", ...(timeZone ? { timeZone } : {}) }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]),
  );
  return `${p.day}/${p.month}`;
};
const daysLate = (iso: string | null, now: number) => (iso ? Math.max(1, Math.floor((now - new Date(iso).getTime()) / 86400_000)) : 0);

function lateOf(x: FollowPerson): FollowTask[] {
  const all = [...(x.tasks ?? []), ...(x.late ?? []), ...(x.now ?? [])].filter((t) => t.overdue || (x.late ?? []).some((l) => l.id === t.id));
  const seen = new Set<string>();
  return all.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true))).sort((a, b) => (a.dueAt ?? "").localeCompare(b.dueAt ?? ""));
}

export interface Grounded {
  text: string;
  sources: Source[];
}

/** The deterministic answer to a late question, as Markdown with links to the people and tasks. */
export function renderLate(team: FollowTeam, intent: LateIntent, lang: Loc, now = Date.now(), timeZone?: string): Grounded {
  const link = (t: FollowTask) => `[${t.code}](/app/work/tasks/${t.id}) ${t.title}`;
  const due = (t: FollowTask) => {
    const [d, n] = [dm(t.dueAt, timeZone), daysLate(t.dueAt, now)];
    return say(lang, { en: `due ${d}, ${n}d late`, vi: `hạn ${d}, trễ ${n} ngày`, zh: `截止 ${d}，逾期 ${n} 天`, es: `vence ${d}, ${n} d de retraso` });
  };
  const progress = say(lang, { en: "Progress", vi: "Tiến độ", zh: "进度", es: "Progreso" });
  if (team.scope === "none")
    return {
      text: say(lang, {
        en: "Nobody reports to you, so there is no team to check.",
        vi: "Bạn chưa quản lý ai trong sơ đồ tổ chức, nên chưa có đội để xem.",
        zh: "组织架构中没有人向你汇报，所以没有团队可查看。",
        es: "Nadie depende de ti en el organigrama, así que no hay equipo que revisar.",
      }),
      sources: [],
    };
  let people = team.people;
  if (intent.department) {
    const inDept = people.filter((x) => x.department && deptMatches(x.department, intent.department!));
    if (!inDept.length) {
      const dep = intent.department;
      return {
        text: say(lang, {
          en: `I don't see a department called "${dep}" among the people you follow. See [${progress}](/app/ai/progress).`,
          vi: `Mình không thấy phòng ban "${dep}" trong những người bạn theo dõi. Xem [${progress}](/app/ai/progress).`,
          zh: `在你关注的人中没有找到名为"${dep}"的部门。查看[${progress}](/app/ai/progress)。`,
          es: `No veo un departamento llamado "${dep}" entre las personas que sigues. Mira [${progress}](/app/ai/progress).`,
        }),
        sources: [],
      };
    }
    people = inDept;
  }
  if (intent.person) {
    const want = fold(intent.person);
    const hit = people.filter((x) => fold(x.displayName).includes(want) || want.includes(fold(x.displayName)));
    if (!hit.length) {
      const who = intent.person;
      return {
        text: say(lang, {
          en: `I don't see anyone called "${who}" among the people you follow. Try [People](/app/me/people) or [${progress}](/app/ai/progress).`,
          vi: `Mình không thấy ai tên "${who}" trong những người bạn theo dõi. Thử tìm ở [Danh bạ](/app/me/people) hoặc xem [${progress}](/app/ai/progress).`,
          zh: `在你关注的人中没有找到"${who}"。试试[通讯录](/app/me/people)或[${progress}](/app/ai/progress)。`,
          es: `No veo a nadie llamado "${who}" entre las personas que sigues. Prueba en [Personas](/app/me/people) o [${progress}](/app/ai/progress).`,
        }),
        sources: [],
      };
    }
    const parts = hit.slice(0, 3).map((x) => {
      const late = lateOf(x);
      const name = `[${x.displayName}](/app/work/people/${x.userId})`;
      const n = late.length;
      if (!n)
        return say(lang, {
          en: `${name} has no late tasks (${x.open} open).`,
          vi: `${name} không có việc nào trễ hạn (đang mở ${x.open} việc).`,
          zh: `${name} 没有逾期任务（进行中 ${x.open} 个）。`,
          es: `${name} no tiene tareas atrasadas (${x.open} abiertas).`,
        });
      const head = say(lang, {
        en: `${name} is late on ${n} task${n === 1 ? "" : "s"}:`,
        vi: `${name} đang trễ ${n} việc:`,
        zh: `${name} 有 ${n} 个逾期任务：`,
        es: `${name} tiene ${n} tarea${n === 1 ? "" : "s"} atrasada${n === 1 ? "" : "s"}:`,
      });
      return [head, ...late.slice(0, 10).map((t) => `- ${link(t)} (${due(t)})`)].join("\n");
    });
    return {
      text: parts.join("\n\n"),
      sources: hit.slice(0, 3).map((x) => ({ type: "employee" as const, id: x.userId, title: x.displayName, url: `/app/work/people/${x.userId}` })),
    };
  }
  const late = people.filter((x) => lateOf(x).length > 0).sort((a, b) => lateOf(b).length - lateOf(a).length);
  const dep = intent.department;
  const where = dep ? say(lang, { en: ` in ${dep}`, vi: ` ở ${dep}`, zh: `（${dep}）`, es: ` en ${dep}` }) : "";
  if (!late.length)
    return {
      text: say(lang, {
        en: `Nobody${where} has a late task right now.`,
        vi: `Hiện không ai${where} có việc trễ hạn.`,
        zh: `目前${where}没有人有逾期任务。`,
        es: `Ahora mismo nadie${where} tiene tareas atrasadas.`,
      }),
      sources: [],
    };
  const total = late.reduce((n, x) => n + lateOf(x).length, 0);
  const k = late.length;
  const head = say(lang, {
    en: `${k} ${k === 1 ? "person" : "people"}${where} ${k === 1 ? "has" : "have"} late tasks (${total} in all):`,
    vi: `${k} người${where} đang có việc trễ hạn (tổng ${total} việc):`,
    zh: `${k} 人${where}有逾期任务（共 ${total} 个）：`,
    es: `${k} ${k === 1 ? "persona" : "personas"}${where} ${k === 1 ? "tiene" : "tienen"} tareas atrasadas (${total} en total):`,
  });
  const rows = late.slice(0, 12).map((x) => {
    const ts = lateOf(x);
    const name = `**[${x.displayName}](/app/work/people/${x.userId})**${x.department && !dep ? ` · ${x.department}` : ""}`;
    const shown = ts.slice(0, 3).map(link).join("; ");
    const m = ts.length - 3;
    const more = m > 0 ? say(lang, { en: ` and ${m} more`, vi: ` và ${m} việc khác`, zh: ` 等另外 ${m} 个`, es: ` y ${m} más` }) : "";
    return `- ${name}: ${ts.length} ${say(lang, { en: "late", vi: "việc trễ", zh: "个逾期", es: "atrasadas" })} (${shown}${more})`;
  });
  const r = late.length - 12;
  const extra =
    r > 0
      ? [
          say(lang, {
            en: `- …and ${r} more. See [${progress}](/app/ai/progress).`,
            vi: `- …và ${r} người khác. Xem [${progress}](/app/ai/progress).`,
            zh: `- …还有 ${r} 人。查看[${progress}](/app/ai/progress)。`,
            es: `- …y ${r} más. Mira [${progress}](/app/ai/progress).`,
          }),
        ]
      : [];
  return {
    text: [head, ...rows, ...extra].join("\n"),
    sources: late.slice(0, 10).map((x) => ({ type: "employee" as const, id: x.userId, title: x.displayName, url: `/app/work/people/${x.userId}` })),
  };
}

/** Reads the follow-up data as the asker and answers a late question, or null when the question is not one. */
export async function answerLate(ctx: Pick<ToolContext, "services" | "lang" | "loc" | "timeZone">, principal: Principal, question: string): Promise<Grounded | null> {
  const intent = lateIntent(question);
  if (!intent || !principal) return null;
  const team = await ctx.services.work.request<FollowTeam>("GET", "/followup/team", undefined, principal);
  return renderLate(team, intent, ctx.loc ?? (ctx.lang === "vi" ? "vi" : "en"), Date.now(), ctx.timeZone);
}

/** "What's blocked?", "việc nào bị chặn", "哪些任务被阻塞了", "¿Qué está bloqueado?" (optionally in a department). */
export function blockedIntent(question: string): { department?: string } | null {
  const q = question.trim();
  if (!/\b(blocked|stuck)\b|bị chặn|đang kẹt|阻塞|卡住|受阻|bloquead|atascad/i.test(q)) return null;
  const department = departmentIn(q);
  return department ? { department } : {};
}

/** The blocked tasks of the people the asker follows, with who has each and why, as Markdown. */
export function renderBlocked(team: FollowTeam, intent: { department?: string }, lang: Loc): Grounded {
  const people = intent.department ? team.people.filter((x) => x.department && deptMatches(x.department, intent.department!)) : team.people;
  const rows: { p: FollowPerson; t: FollowTask }[] = [];
  const seen = new Set<string>();
  for (const p of people)
    for (const t of [...(p.tasks ?? []), ...(p.now ?? []), ...(p.late ?? [])])
      if (t.blockedReason && !seen.has(t.id)) {
        seen.add(t.id);
        rows.push({ p, t });
      }
  const where = intent.department
    ? say(lang, { en: ` in ${intent.department}`, vi: ` ở ${intent.department}`, zh: `（${intent.department}）`, es: ` en ${intent.department}` })
    : "";
  if (!rows.length)
    return {
      text: say(lang, {
        en: `Nothing${where} is blocked right now.`,
        vi: `Hiện không có việc nào${where} bị chặn.`,
        zh: `目前${where}没有被阻塞的任务。`,
        es: `Ahora mismo no hay nada bloqueado${where}.`,
      }),
      sources: [],
    };
  const n = rows.length;
  const head = say(lang, {
    en: `${n} task${n === 1 ? " is" : "s are"} blocked${where}:`,
    vi: `${n} việc${where} đang bị chặn:`,
    zh: `${where}有 ${n} 个任务被阻塞：`,
    es: `${n} tarea${n === 1 ? " está bloqueada" : "s están bloqueadas"}${where}:`,
  });
  const lines = rows
    .slice(0, 15)
    .map(({ p, t }) => `- [${t.code}](/app/work/tasks/${t.id}) ${t.title} · [${p.displayName}](/app/work/people/${p.userId}) · ${t.blockedReason!.slice(0, 140)}`);
  return { text: [head, ...lines].join("\n"), sources: rows.slice(0, 10).map(({ t }) => ({ type: "task" as const, id: t.id, title: t.code, url: `/app/work/tasks/${t.id}` })) };
}

/** Reads the follow-up data as the asker and answers a blocked question, or null when the question is not one. */
export async function answerBlocked(ctx: Pick<ToolContext, "services" | "lang" | "loc">, principal: Principal, question: string): Promise<Grounded | null> {
  const intent = blockedIntent(question);
  if (!intent || !principal) return null;
  const team = await ctx.services.work.request<FollowTeam>("GET", "/followup/team", undefined, principal);
  if (team.scope === "none") return null;
  return renderBlocked(team, intent, ctx.loc ?? (ctx.lang === "vi" ? "vi" : "en"));
}

/**
 * A question about the workspace's own people, teams, projects, tasks or figures, in any of the four languages:
 * these get answered from data or not at all. "Write me an email", "explain OKRs" stay plain chat.
 */
export function aboutWorkspace(question: string): boolean {
  const q = question.toLowerCase();
  return /\b(team|department|dept|project|projects|task|tasks|my staff|employees?|colleagues?|who (?:is|are|did|has|have)|finish(?:ed)?|done this week|this week|last week|overdue|blocked|on leave|out today|sales|engineering|marketing|finance|revenue|workload)\b|(đội|phòng ban|phòng|dự án|việc|nhân viên|ai đang|ai đã|tuần này|tuần trước|bị chặn|nghỉ phép|doanh số|công ty mình)|(团队|部门|项目|任务|员工|同事|谁|本周|这周|上周|完成了|逾期|阻塞|请假|休假|销售|工程)|\b(equipo|departamento|proyectos?|tareas?|empleados?|compañeros|quién|quiénes|esta semana|semana pasada|terminó|terminaron|completaron|bloquead[oa]s?|vacaciones|de baja|ventas|ingeniería)\b/u.test(
    q,
  );
}

/** Given names small models reach for when they make a team up (English and Vietnamese). */
const GIVEN = new Set(
  "john jane alice bob charlie david emma emily james mary michael sarah tom anna peter paul linda mike chris kate lisa mark minh linh lan hung hoa mai nam an binh trang tuan huong ha nga long khoa".split(
    " ",
  ),
);
const CODE = /\b[A-Z][A-Z0-9]{0,9}-\d{1,6}\b/g;

/**
 * Whether a model's answer stays inside the data it was given: every task code it names was in the data or the
 * question, and every name in a list row or table cell appears there too. Small models asked about a team they
 * cannot see invent one ("John · T-001"); this catches it so the caller can show the data instead.
 */
export function groundedIn(answer: string, data: string, question: string): { ok: boolean; unknown: string[] } {
  const hay = fold(`${data}\n${question}`);
  const codes = [...new Set(answer.match(CODE) ?? [])].filter((c) => !hay.includes(fold(c)));
  // Names: capitalised words at the start of list items or inside table cells ("- John:", "| Alice |", "1. **Bob**").
  const names = new Set<string>();
  for (const line of answer.split("\n")) {
    const cells = line.includes("|") ? line.split("|").map((x) => x.trim()) : [line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim()];
    if (!line.includes("|") && !/^\s*(?:[-*•]|\d+[.)])\s+/.test(line)) continue;
    for (const cell of cells) {
      const m = /^\**\s*\[?([A-ZÀ-Ỹ][\p{Ll}]+(?:\s+[A-ZÀ-Ỹ][\p{Ll}]+){0,3})\b/u.exec(cell);
      if (m?.[1] && m[1].split(/\s+/).length >= 1) names.add(m[1]);
    }
  }
  // Only words that look like a person's name: in the data's people, or two capitalised words, or a common given name.
  const unknownNames = [...names].filter((n) => {
    if (hay.includes(fold(n))) return false;
    const first = fold(n.split(/\s+/)[0] ?? "");
    return n.split(/\s+/).length >= 2 || GIVEN.has(first);
  });
  // Placeholders a model fills a gap with ("$XXX", "[price]", "[Your Name]", "XX%") and money or percentages the data
  // does not contain: an answer about the company's own numbers that makes one up is not an answer.
  const placeholders =
    answer.match(/\$\s?X{2,}|\bX{3,}\b|\bXX%|\[(?:price|amount|name|your name|company|date|giá|tên|số tiền|价格|姓名|金额|precio|nombre|importe)[^\]]{0,20}\]/gi) ?? [];
  const figures = [...new Set(answer.match(/(?:[$€£¥₫]\s?\d[\d.,]*|\d[\d.,]*\s?(?:%|usd|eur|vnd|đ|元|美元))/gi) ?? [])].filter(
    (f) => !hay.includes(fold(f).replace(/\s+/g, "")) && !hay.includes(fold(f.replace(/[^\d.,]/g, ""))),
  );
  const unknown = [...codes, ...unknownNames, ...placeholders, ...figures];
  return { ok: unknown.length === 0, unknown };
}

/**
 * Today's date for a prompt, in the workspace's time zone, with the weeks spelled out: small models asked for
 * "next week" otherwise pick this week, or write a weekday with no date.
 */
export function datesLine(now = new Date(), timeZone = "UTC", loc: Loc = "en"): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "long" }).formatToParts(now);
  const get = (t: string) => parts.find((x) => x.type === t)?.value ?? "";
  const y = Number(get("year"));
  const m = Number(get("month"));
  const d = Number(get("day"));
  const local = Date.UTC(y, m - 1, d);
  const dow = (new Date(local).getUTCDay() + 6) % 7; // Monday 0
  const day = (offset: number) => {
    const x = new Date(local + offset * 86400_000);
    return `${String(x.getUTCDate()).padStart(2, "0")}/${String(x.getUTCMonth() + 1).padStart(2, "0")}/${x.getUTCFullYear()}`;
  };
  const word = say(loc, { en: "due", vi: "hạn", zh: "截止", es: "vence" });
  return `Today is ${get("weekday")} ${day(0)} (workspace time). Weeks start on Monday. This week runs ${day(-dow)} to ${day(6 - dow)}; next week ("next week", "tuần tới", "下周", "la próxima semana") runs Monday ${day(7 - dow)} to Sunday ${day(13 - dow)}. A deadline "next week" with no day means Friday ${day(11 - dow)}. When a step has a deadline, end its line with " (${word} dd/mm/yyyy)" using an exact date, never a weekday alone. Keep each step's title short (under 80 characters, no full sentences) and never write a task code (like T-123) that is not in the data.`;
}
