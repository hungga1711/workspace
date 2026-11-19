import { BadRequestException, Body, Controller, Get, Inject, Put, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { newId, runWithContext, withTransaction, workspaceTimeZone, recordAudit, type Principal } from "@workspace/shared";
import { assertAllowed, emailLayout, env, logger, mailConfigured, requirePrincipal, type Mailer } from "@workspace/service-kit";
import { DEPS } from "./ai.controller.js";
import { aiAudience, type Person } from "./audience.js";
import { capabilityMap, helpfulScore, type UseStats } from "./capability.js";
import { HOURLY_COST, HOURLY_COST_JOIN, HOURLY_UNPRICED } from "./hourly-stats.js";
import { topicList, type CompanyTopic } from "./topics.js";
import { aiFlags } from "./status.js";
import type { Deps } from "./runtime.js";
import { aiSinceSql, aiUsers } from "./metrics.js";

/**
 * The owner's one-page weekly report (Công việc › AI › Báo cáo tuần, and optionally a Monday email): what AI is
 * used for, by whom and which departments, whether people say it helps and whether tasks done with it go better,
 * what it cost, what the sensitive-data filter caught, and three things to do next. Counts only, never conversation text;
 * the recommendations come from rules, so the report needs no model.
 */

interface Group {
  done: number;
  dated: number;
  onTime: number;
  cycleDays: number | null;
}

export interface ReportInput {
  people: number;
  extension: number;
  conversations: number;
  rated: number;
  helpful: { yes: number; partly: number; no: number };
  flagged: number;
  safety: { warn: number; redact: number; block: number };
  sensitiveMode: "warn" | "redact" | "block";
  topics: { key: string; prompts: number; rated: number; yes: number; partly: number }[];
  departments: { name: string | null; people: number; active: number }[];
  mentors: { displayName: string; department: string | null }[];
  work: { assisted: Group; other: Group } | null;
  unpricedTokens: number;
  library: number;
}

export interface Recommendation {
  key:
    | "install_extension"
    | "turn_on_redaction"
    | "review_sensitive"
    | "ask_feedback"
    | "coach_topic"
    | "pair_mentors"
    | "pilot_department"
    | "link_tasks"
    | "share_prompts"
    | "set_prices"
    | "celebrate"
    | "review_policy"
    | "browse_library"
    | "keep_going";
  params: Record<string, string | number>;
}

/** Three next steps from the week's numbers, most pressing first; data safety before adoption before polish. */
export function recommend(x: ReportInput): Recommendation[] {
  const out: Recommendation[] = [];
  const add = (key: Recommendation["key"], params: Recommendation["params"] = {}) => out.push({ key, params });
  const missing = x.people - x.extension;
  if (x.people >= 2 && x.extension / x.people < 0.5) add("install_extension", { missing });
  const caught = x.flagged + x.safety.warn;
  if (x.sensitiveMode === "warn" && caught > 0) add("turn_on_redaction", { count: caught });
  if (x.sensitiveMode !== "warn" && x.safety.redact + x.safety.block >= 3) add("review_sensitive", { count: x.safety.redact + x.safety.block });
  if (x.conversations >= 10 && x.rated / x.conversations < 0.2) add("ask_feedback");
  const weak = x.topics.filter((t) => t.rated >= 3 && (helpfulScore({ rated: t.rated, yes: t.yes, partly: t.partly }) ?? 1) < 0.5).sort((a, b) => b.prompts - a.prompts)[0];
  if (weak) add("coach_topic", { topic: weak.key });
  if (x.mentors.length)
    add("pair_mentors", {
      names: x.mentors
        .slice(0, 2)
        .map((m) => m.displayName)
        .join(", "),
      count: x.mentors.length,
    });
  const idle = x.departments.filter((d) => d.name && d.people >= 3 && d.active === 0).sort((a, b) => b.people - a.people)[0];
  if (idle) add("pilot_department", { department: idle.name! });
  if (x.conversations >= 5 && x.work && x.work.assisted.done === 0) add("link_tasks");
  if (x.helpful.yes >= 5 && x.library < 5) add("share_prompts");
  if (x.unpricedTokens > 0) add("set_prices");
  // A quiet week still gets three steps: habits that keep AI use healthy.
  if (x.helpful.yes > 0) add("celebrate", { count: x.helpful.yes });
  add("review_policy");
  if (x.library > 0) add("browse_library");
  add("keep_going");
  return out.slice(0, 3);
}

/** Monday of the week containing `day` (YYYY-MM-DD), as YYYY-MM-DD. */
export function mondayOf(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/** Whether the weekly email is due: Monday from 08:00 in the workspace's zone, once per week. */
export function weeklyDue(now: Date, timeZone: string, lastSentWeek: string | null): { due: boolean; week: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23", weekday: "short" })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  const week = mondayOf(day);
  return { due: parts.weekday === "Mon" && Number(parts.hour) >= 8 && lastSentWeek !== week, week };
}

const SETTINGS = z.object({ weeklyEmail: z.boolean() });

async function buildReport(d: Deps, p: Principal, days: number, audience?: { people: Person[] }) {
  const { people } = audience ?? (await aiAudience(d, p));
  const ids = people.map((x) => x.userId);
  const since = aiSinceSql(days);
  const workP = d.services.work
    .request<{ withAi?: { assisted: Group; other: Group } }>("GET", `/followup/outcomes?days=${days}`, undefined, p)
    .then((r) => r.withAi ?? null)
    .catch(() => null);
  const data = await withTransaction(d.pool, async (c) => {
    const per = (
      await c.query<UseStats & { flagged: number; no: number; ext_cost: number }>(
        `SELECT user_id AS "userId", count(*)::int AS conversations, coalesce(sum(messages), 0)::int AS prompts,
                count(helpful)::int AS rated, count(*) FILTER (WHERE helpful = 'yes')::int AS yes,
                count(*) FILTER (WHERE helpful = 'partly')::int AS partly, count(*) FILTER (WHERE helpful = 'no')::int AS no,
                count(*) FILTER (WHERE cardinality(sensitive) > 0)::int AS flagged, coalesce(sum(ext_cost_usd), 0)::float AS ext_cost
           FROM ai_conversations WHERE last_at > ${since} AND user_id = ANY($1::text[]) GROUP BY user_id`,
        [ids],
      )
    ).rows;
    const topics = (
      await c.query<{ key: string; prompts: number; rated: number; yes: number; partly: number }>(
        `SELECT topic AS key, coalesce(sum(messages), 0)::int AS prompts, count(helpful)::int AS rated,
                count(*) FILTER (WHERE helpful = 'yes')::int AS yes, count(*) FILTER (WHERE helpful = 'partly')::int AS partly
           FROM ai_conversations WHERE last_at > ${since} AND user_id = ANY($1::text[]) GROUP BY topic ORDER BY 2 DESC`,
        [ids],
      )
    ).rows;
    const sources = (
      await c.query<{ key: string; prompts: number }>(
        `SELECT source AS key, coalesce(sum(messages), 0)::int AS prompts FROM ai_conversations WHERE last_at > ${since} AND user_id = ANY($1::text[])
          GROUP BY source ORDER BY 2 DESC`,
        [ids],
      )
    ).rows;
    const cost = (
      await c.query<{ cost: number; unpriced: number }>(
        `SELECT coalesce(sum(${HOURLY_COST}), 0)::float AS cost, coalesce(sum(${HOURLY_UNPRICED}), 0)::bigint::float AS unpriced
           FROM ai_hourly_stats s ${HOURLY_COST_JOIN} WHERE s.feature <> '' AND s.hour >= date_trunc('hour', ${since}) AND s.user_id = ANY($1::text[])`,
        [ids],
      )
    ).rows[0] ?? { cost: 0, unpriced: 0 };
    const safety = Object.fromEntries(
      (
        await c.query<{ action: string; n: number }>(
          `SELECT action, coalesce(sum(count), 0)::int AS n FROM ai_safety_events WHERE at > ${since} AND user_id = ANY($1::text[]) GROUP BY action`,
          [ids],
        )
      ).rows.map((r) => [r.action, r.n]),
    );
    const extension = (
      await c.query<{ n: number }>("SELECT count(*)::int AS n FROM ai_monitor_tokens WHERE user_id = ANY($1::text[]) AND last_seen_at > now() - interval '14 days'", [ids])
    ).rows[0]!.n;
    const mode = (await c.query<{ m: "warn" | "redact" | "block" }>("SELECT sensitive_mode AS m FROM ai_policy LIMIT 1")).rows[0]?.m ?? "warn";
    // Prompts others can use: the company's live ones and personal ones shared beyond their author (not proposals).
    const library = (
      await c.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM ai_prompt_library WHERE (level = 'company' AND status = 'live') OR (level = 'personal' AND visibility <> 'private')",
      )
    ).rows[0]!.n;
    const labels = topicList((await c.query<CompanyTopic>(`SELECT key, label_vi AS "labelVi", label_en AS "labelEn", keywords, builtin, archived FROM ai_topics`)).rows);
    // The same "uses AI" as Home and Usage (metrics.ts): prompts or the app's AI actions, not prompts alone.
    const users = await aiUsers(c, ids, days);
    return { per, users, topics, sources, cost, safety, extension, mode, library, labels, timeZone: await workspaceTimeZone(c) };
  });
  const work = await workP;
  const byUser = new Map(data.per.map((r) => [r.userId, r]));
  const depts = new Map<string, { name: string | null; people: number; active: number; prompts: number; rated: number; yes: number; partly: number; flagged: number }>();
  for (const x of people) {
    const k = x.department ?? "";
    const g = depts.get(k) ?? { name: x.department ?? null, people: 0, active: 0, prompts: 0, rated: 0, yes: 0, partly: 0, flagged: 0 };
    const s = byUser.get(x.userId);
    g.people++;
    if (data.users.has(x.userId)) g.active++;
    g.prompts += s?.prompts ?? 0;
    g.rated += s?.rated ?? 0;
    g.yes += s?.yes ?? 0;
    g.partly += s?.partly ?? 0;
    g.flagged += s?.flagged ?? 0;
    depts.set(k, g);
  }
  const sum = (f: (r: (typeof data.per)[number]) => number) => data.per.reduce((n, r) => n + f(r), 0);
  const helpful = { yes: sum((r) => r.yes), partly: sum((r) => r.partly), no: sum((r) => r.no) };
  const mentors = capabilityMap(people, data.per).flatMap((g) => g.top.filter((t) => t.mentor).map((t) => ({ displayName: t.displayName, department: g.name })));
  const departments = [...depts.values()].sort((a, b) => Number(a.name === null) - Number(b.name === null) || b.prompts - a.prompts);
  const input: ReportInput = {
    people: people.length,
    extension: data.extension,
    conversations: sum((r) => r.conversations),
    rated: sum((r) => r.rated),
    helpful,
    flagged: sum((r) => r.flagged),
    safety: { warn: data.safety.warn ?? 0, redact: data.safety.redact ?? 0, block: data.safety.block ?? 0 },
    sensitiveMode: data.mode,
    topics: data.topics,
    departments,
    mentors,
    work,
    unpricedTokens: data.cost.unpriced,
    library: data.library,
  };
  const names = new Map(people.map((x) => [x.userId, x]));
  return {
    days,
    timeZone: data.timeZone,
    generatedAt: new Date().toISOString(),
    totals: {
      people: input.people,
      active: data.users.size,
      extension: input.extension,
      conversations: input.conversations,
      prompts: sum((r) => r.prompts),
      rated: input.rated,
      helpful,
      flagged: input.flagged,
      safety: input.safety,
      costUsd: data.cost.cost,
      importedCostUsd: sum((r) => r.ext_cost),
      unpricedTokens: data.cost.unpriced,
    },
    sensitiveMode: data.mode,
    topics: data.topics.slice(0, 6),
    sources: data.sources,
    departments: departments.slice(0, 8),
    people: [...data.per]
      .sort((a, b) => b.prompts - a.prompts)
      .slice(0, 5)
      .map((r) => ({
        userId: r.userId,
        displayName: names.get(r.userId)?.displayName ?? "",
        department: names.get(r.userId)?.department ?? null,
        prompts: r.prompts,
        score: helpfulScore(r),
      })),
    mentors,
    work,
    topicLabels: data.labels.filter((t) => t.labelVi || t.labelEn).map((t) => ({ key: t.key, labelVi: t.labelVi, labelEn: t.labelEn })),
    recommendations: recommend(input),
  };
}
export type Report = Awaited<ReturnType<typeof buildReport>>;

@Controller()
export class ReportController {
  constructor(@Inject(DEPS) private readonly d: Deps) {}

  @Get("insights/report")
  async report(@Req() req: Request, @Query("days") daysQ?: string) {
    const p = requirePrincipal(req);
    return buildReport(this.d, p, Number(daysQ) === 30 ? 30 : 7);
  }

  @Get("insights/report/settings")
  async settings(@Req() req: Request) {
    const p = requirePrincipal(req);
    assertAllowed(p, "ai.policy.manage");
    return withTransaction(this.d.pool, async (c) => {
      const r = (
        await c.query<{ weekly_email: boolean; last_sent_week: string | null }>(
          "SELECT weekly_email, to_char(last_sent_week, 'YYYY-MM-DD') AS last_sent_week FROM ai_report_settings",
        )
      ).rows[0];
      return { weeklyEmail: r?.weekly_email ?? false, lastSentWeek: r?.last_sent_week ?? null, mailConfigured: mailConfigured() };
    });
  }

  @Put("insights/report/settings")
  async save(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "ai.policy.manage");
    const b = SETTINGS.safeParse(body);
    if (!b.success) throw new BadRequestException("weeklyEmail: boolean");
    return withTransaction(this.d.pool, async (c) => {
      await c.query(
        `INSERT INTO ai_report_settings (weekly_email, updated_by) VALUES ($1, $2)
         ON CONFLICT (singleton) DO UPDATE SET weekly_email = EXCLUDED.weekly_email, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [b.data.weeklyEmail, p.id],
      );
      await recordAudit(c, { action: "ai.report.settings_updated", targetType: "settings", targetId: "ai_report", meta: { weeklyEmail: b.data.weeklyEmail } });
      return { weeklyEmail: b.data.weeklyEmail, mailConfigured: mailConfigured() };
    });
  }
}

// ---------------------------------------------------------------- the Monday email

export type Lang = "vi" | "en" | "zh" | "es";
const T = {
  vi: {
    subject: (n: number) => `Dùng AI trong công việc tuần qua: ${n} hội thoại`,
    title: "Báo cáo AI tuần qua",
    used: (prompts: number, active: number, people: number) => `${prompts} lượt hỏi AI; ${active}/${people} người có dùng AI.`,
    topics: (list: string) => `Dùng nhiều nhất cho: ${list}.`,
    helpful: (yes: number, rated: number) => (rated ? `Nhân viên đánh giá AI có giúp ích ở ${yes}/${rated} hội thoại.` : "Chưa có ai đánh giá AI có giúp ích hay không."),
    safety: (n: number) => (n ? `Lọc dữ liệu nhạy cảm: ${n} lần cảnh báo, che hoặc chặn dữ liệu nhạy cảm.` : "Không có cảnh báo dữ liệu nhạy cảm."),
    cost: (usd: string) => `Chi phí AI của công ty: ${usd}.`,
    next: "Ba việc nên làm tuần này:",
    open: "Mở báo cáo",
    firstSubject: "Báo cáo AI đầu tiên của công ty bạn",
    firstTitle: "Tuần đầu dùng AI",
    firstIntro: "Đây là báo cáo đầu tiên, sau 7 ngày cài đặt. Từ giờ báo cáo đến mỗi sáng thứ Hai; tắt trong Quản trị › AI.",
    quiet: "Chưa đủ dữ liệu để so sánh việc có AI và không có AI: cần vài tuần và tiện ích trình duyệt trên máy mọi người.",
    none: "Chưa ghi nhận lượt dùng AI nào. Cài tiện ích trình duyệt hoặc nhập lịch sử ChatGPT/Claude trong Quản trị › AI.",
  },
  en: {
    subject: (n: number) => `AI at work last week: ${n} conversations`,
    title: "Last week's AI report",
    used: (prompts: number, active: number, people: number) => `${prompts} AI prompts; ${active} of ${people} people used AI.`,
    topics: (list: string) => `Used most for: ${list}.`,
    helpful: (yes: number, rated: number) => (rated ? `Staff rated ${yes} of ${rated} conversations "helpful".` : "Nobody has rated whether AI helped yet."),
    safety: (n: number) => (n ? `Sensitive-data filter: ${n} warnings, redactions or blocks.` : "No sensitive-data warnings."),
    cost: (usd: string) => `Company AI cost: ${usd}.`,
    next: "Three things to do:",
    open: "Open the report",
    firstSubject: "Your company's first AI report",
    firstTitle: "Your first week of AI at work",
    firstIntro: "This is your first report, 7 days after setup. From now on it arrives every Monday morning; turn it off in Admin › AI.",
    quiet: "Not enough data yet to compare work done with and without AI: it takes a few weeks and the browser extension on everyone's machine.",
    none: "No AI use recorded yet. Install the browser extension, or import ChatGPT/Claude history in Admin › AI.",
  },
  zh: {
    subject: (n: number) => `上周工作中的 AI:${n} 个对话`,
    title: "上周 AI 报告",
    used: (prompts: number, active: number, people: number) => `${prompts} 次 AI 提问;${people} 人中有 ${active} 人使用了 AI。`,
    topics: (list: string) => `最常用于:${list}。`,
    helpful: (yes: number, rated: number) => (rated ? `员工认为 ${rated} 个对话中有 ${yes} 个“有帮助”。` : "还没有人评价 AI 是否有帮助。"),
    safety: (n: number) => (n ? `敏感数据过滤:${n} 次警告、遮盖或拦截。` : "没有敏感数据警告。"),
    cost: (usd: string) => `公司 AI 费用:${usd}。`,
    next: "本周建议做的三件事:",
    open: "打开报告",
    firstSubject: "贵公司的第一份 AI 报告",
    firstTitle: "工作中使用 AI 的第一周",
    firstIntro: "这是安装 7 天后的第一份报告。今后每周一早上发送;可在 管理 › AI 中关闭。",
    quiet: "数据还不足以比较使用和不使用 AI 的工作:需要几周时间,并在每个人的电脑上安装浏览器扩展。",
    none: "尚未记录任何 AI 使用。请安装浏览器扩展,或在 管理 › AI 中导入 ChatGPT/Claude 历史。",
  },
  es: {
    subject: (n: number) => `La IA en el trabajo la semana pasada: ${n} conversaciones`,
    title: "Informe de IA de la semana pasada",
    used: (prompts: number, active: number, people: number) => `${prompts} consultas a la IA; ${active} de ${people} personas usaron IA.`,
    topics: (list: string) => `Usada sobre todo para: ${list}.`,
    helpful: (yes: number, rated: number) => (rated ? `El equipo valoró ${yes} de ${rated} conversaciones como "útiles".` : "Nadie ha valorado todavía si la IA ayudó."),
    safety: (n: number) => (n ? `Filtro de datos sensibles: ${n} avisos, ocultaciones o bloqueos.` : "Sin avisos de datos sensibles."),
    cost: (usd: string) => `Coste de la IA de la empresa: ${usd}.`,
    next: "Tres cosas para hacer:",
    open: "Abrir el informe",
    firstSubject: "El primer informe de IA de tu empresa",
    firstTitle: "Tu primera semana de IA en el trabajo",
    firstIntro: "Este es tu primer informe, 7 días después de la instalación. A partir de ahora llega cada lunes por la mañana; desactívalo en Administración › IA.",
    quiet: "Aún no hay datos suficientes para comparar el trabajo hecho con y sin IA: hacen falta unas semanas y la extensión del navegador en todos los equipos.",
    none: "Aún no se ha registrado uso de IA. Instala la extensión del navegador o importa el historial de ChatGPT/Claude en Administración › IA.",
  },
} as const;

const TOPIC_NAMES: Record<Lang, Record<string, string>> = {
  vi: {
    code: "lập trình",
    writing: "viết",
    analysis: "phân tích số liệu",
    translation: "dịch",
    research: "tìm hiểu",
    sales: "bán hàng",
    hr: "nhân sự",
    design: "thiết kế",
    planning: "lập kế hoạch",
    other: "việc khác",
  },
  en: {
    code: "coding",
    writing: "writing",
    analysis: "analysis",
    translation: "translation",
    research: "research",
    sales: "sales",
    hr: "HR",
    design: "design",
    planning: "planning",
    other: "other",
  },
  zh: {
    code: "编程",
    writing: "写作",
    analysis: "数据分析",
    translation: "翻译",
    research: "调研",
    sales: "销售",
    hr: "人事",
    design: "设计",
    planning: "计划",
    other: "其他",
  },
  es: {
    code: "programación",
    writing: "redacción",
    analysis: "análisis",
    translation: "traducción",
    research: "investigación",
    sales: "ventas",
    hr: "RR. HH.",
    design: "diseño",
    planning: "planificación",
    other: "otros",
  },
};

/** The recommendation sentences, for the email (the web page has its own copy in the i18n messages). */
export function recommendationText(r: Recommendation, lang: Lang, topicName: (k: string) => string): string {
  const p = r.params;
  const vi: Record<Recommendation["key"], string> = {
    install_extension: `Nhắc ${p.missing} người chưa cài tiện ích trình duyệt (AI › Áp dụng AI › Mức sử dụng › Nhắc cài tiện ích).`,
    turn_on_redaction: `Có ${p.count} lần dữ liệu nhạy cảm bị cảnh báo: cân nhắc chuyển sang "tự che trước khi gửi" trong Quản trị › AI.`,
    review_sensitive: `Bộ lọc dữ liệu nhạy cảm đã che hoặc chặn ${p.count} lần: xem lại danh sách từ khoá và nhắc lại quy định dùng AI.`,
    ask_feedback: `Ít hội thoại được đánh giá "AI có giúp ích không": nhắc mọi người bấm đánh giá sau mỗi hội thoại.`,
    coach_topic: `AI ít giúp ở chủ đề "${topicName(String(p.topic))}": chia sẻ prompt mẫu hoặc thử công cụ khác cho việc này.`,
    pair_mentors: `${p.names} dùng AI hiệu quả: mời họ hướng dẫn đồng nghiệp trong phòng.`,
    pilot_department: `Phòng ${p.department} chưa ai dùng AI: chọn một việc lặp lại để thử trong tuần này.`,
    link_tasks: `Chưa có hội thoại nào gắn với công việc: nhắc mọi người gắn hội thoại vào việc trong Của tôi › AI.`,
    share_prompts: `Nhiều hội thoại được đánh giá "có giúp ích" nhưng thư viện prompt còn ít: mời mọi người chia sẻ prompt.`,
    set_prices: `Một số model chưa có giá: nhập giá trong Quản trị › AI để thấy đúng chi phí.`,
    celebrate: `AI đã giúp trong ${p.count} hội thoại: kể một ví dụ tốt trong buổi họp nhóm.`,
    review_policy: `Đọc lại quy định dùng AI nội bộ cùng nhóm, nhất là phần dữ liệu không được dán vào AI.`,
    browse_library: `Mở Thư viện prompt và thử một prompt đồng nghiệp đã chia sẻ.`,
    keep_going: `Duy trì đều đặn: xem lại báo cáo này vào thứ Hai tới.`,
  };
  const en: Record<Recommendation["key"], string> = {
    install_extension: `Remind the ${p.missing} people without the browser extension (AI › AI adoption › Usage › Remind to install).`,
    turn_on_redaction: `Sensitive data was flagged ${p.count} times: consider "redact before sending" in Admin › AI.`,
    review_sensitive: `The sensitive-data filter redacted or blocked ${p.count} times: review the keyword list and restate the AI policy.`,
    ask_feedback: `Few conversations are rated "did AI help?": remind people to rate each conversation; it takes one tap.`,
    coach_topic: `AI helps less with "${topicName(String(p.topic))}": share example prompts or try another tool for this work.`,
    pair_mentors: `${p.names} use AI well: ask them to show colleagues in their department.`,
    pilot_department: `Nobody in ${p.department} uses AI yet: pick one repetitive task to try this week.`,
    link_tasks: `No conversation is linked to a task yet: ask people to link them in Me › AI.`,
    share_prompts: `Many conversations are rated helpful but the prompt library is small: invite people to share prompts.`,
    set_prices: `Some models have no price: enter prices in Admin › AI to see the real cost.`,
    celebrate: `AI helped in ${p.count} conversations: share one good example at the team meeting.`,
    review_policy: `Go over the internal AI policy with the team, especially what data must never be pasted into AI.`,
    browse_library: `Open the prompt library and try a prompt a colleague shared.`,
    keep_going: `Keep the rhythm: look at this report again next Monday.`,
  };
  const zh: Record<Recommendation["key"], string> = {
    install_extension: `提醒 ${p.missing} 位还没安装浏览器扩展的同事(AI › AI 采用 › 使用情况 › 提醒安装)。`,
    turn_on_redaction: `敏感数据被标记了 ${p.count} 次:考虑在 管理 › AI 中改为“发送前自动遮盖”。`,
    review_sensitive: `敏感数据过滤已遮盖或拦截 ${p.count} 次:检查关键词列表,并重申 AI 使用规定。`,
    ask_feedback: `很少有对话被评价“AI 有没有帮助”:提醒大家每次对话后点一下评价。`,
    coach_topic: `AI 在“${topicName(String(p.topic))}”方面帮助较少:分享示例提示词,或为这类工作换个工具。`,
    pair_mentors: `${p.names} 用 AI 用得好:请他们给部门同事演示。`,
    pilot_department: `${p.department} 还没有人使用 AI:本周选一项重复性工作试试。`,
    link_tasks: `还没有对话关联到任务:请大家在 我的 › AI 中关联。`,
    share_prompts: `很多对话被评为有帮助,但提示词库还很少:邀请大家分享提示词。`,
    set_prices: `部分模型没有价格:在 管理 › AI 中填写价格以看到真实费用。`,
    celebrate: `AI 在 ${p.count} 个对话中帮上了忙:在团队会议上分享一个好例子。`,
    review_policy: `和团队一起回顾内部 AI 使用规定,尤其是哪些数据绝不能贴进 AI。`,
    browse_library: `打开提示词库,试试同事分享的提示词。`,
    keep_going: `保持节奏:下周一再看一次这份报告。`,
  };
  const es: Record<Recommendation["key"], string> = {
    install_extension: `Recuerda a las ${p.missing} personas sin la extensión del navegador que la instalen (IA › Adopción de IA › Uso › Recordar instalación).`,
    turn_on_redaction: `Se marcaron datos sensibles ${p.count} veces: considera "ocultar antes de enviar" en Administración › IA.`,
    review_sensitive: `El filtro de datos sensibles ocultó o bloqueó ${p.count} veces: revisa la lista de palabras clave y recuerda la política de IA.`,
    ask_feedback: `Pocas conversaciones tienen valoración "¿ayudó la IA?": pide al equipo que valore cada conversación; es un solo toque.`,
    coach_topic: `La IA ayuda menos con "${topicName(String(p.topic))}": comparte prompts de ejemplo o prueba otra herramienta para ese trabajo.`,
    pair_mentors: `${p.names} usan bien la IA: pídeles que se lo enseñen a su departamento.`,
    pilot_department: `Nadie en ${p.department} usa IA todavía: elige una tarea repetitiva para probar esta semana.`,
    link_tasks: `Ninguna conversación está vinculada a una tarea: pide al equipo que las vincule en Yo › IA.`,
    share_prompts: `Muchas conversaciones se valoran como útiles pero la biblioteca de prompts es pequeña: invita a compartir prompts.`,
    set_prices: `Algunos modelos no tienen precio: añádelos en Administración › IA para ver el coste real.`,
    celebrate: `La IA ayudó en ${p.count} conversaciones: comparte un buen ejemplo en la reunión del equipo.`,
    review_policy: `Repasa con el equipo la política interna de IA, sobre todo qué datos nunca deben pegarse en una IA.`,
    browse_library: `Abre la biblioteca de prompts y prueba uno que haya compartido un compañero.`,
    keep_going: `Mantén el ritmo: vuelve a mirar este informe el próximo lunes.`,
  };
  return { vi, en, zh, es }[lang][r.key];
}

const INTL: Record<Lang, string> = { vi: "vi-VN", en: "en-US", zh: "zh-CN", es: "es-ES" };

/** The language an email goes out in: the person's own, else the workspace's, else English. */
export function mailLang(...prefs: (string | null | undefined)[]): Lang {
  for (const p of prefs) if (p === "vi" || p === "en" || p === "zh" || p === "es") return p;
  return "en";
}

/**
 * The weekly email; `first` is the one that goes 7 days after setup, with a line on what to expect. Every number is
 * a count from the report; where there is too little to say anything, the email says so instead of a ratio.
 */
export function reportEmail(r: Report, lang: Lang, appUrl: string, first = false): { subject: string; html: string; text: string } {
  const t = T[lang];
  const custom = new Map(r.topicLabels.map((x) => [x.key, lang === "vi" ? x.labelVi || x.labelEn : x.labelEn || x.labelVi]));
  const topicName = (k: string) => custom.get(k) || TOPIC_NAMES[lang][k] || TOPIC_NAMES[lang].other!;
  const s = r.totals.safety;
  const usd = new Intl.NumberFormat(INTL[lang], { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(r.totals.costUsd);
  const lines = [
    ...(first ? [t.firstIntro] : []),
    r.totals.prompts || r.totals.active ? t.used(r.totals.prompts, r.totals.active, r.totals.people) : t.none,
    ...(r.topics.length
      ? [
          t.topics(
            r.topics
              .slice(0, 3)
              .map((x) => topicName(x.key))
              .join(", "),
          ),
        ]
      : []),
    t.helpful(r.totals.helpful.yes, r.totals.rated),
    t.safety(r.totals.flagged + s.warn + s.redact + s.block),
    t.cost(usd),
    ...(r.totals.conversations < 20 ? [t.quiet] : []),
    t.next,
    ...r.recommendations.map((x, i) => `${i + 1}. ${recommendationText(x, lang, topicName)}`),
  ];
  const { html, text } = emailLayout(first ? t.firstTitle : t.title, lines.join("\n"), { label: t.open, url: `${appUrl}/app/ai/adoption/report` }, lang);
  return { subject: first ? t.firstSubject : t.subject(r.totals.conversations), html, text };
}

/**
 * Every hour: the first report goes once, 7 days after the install, from 08:00 in the workspace's zone; after that,
 * Monday from 08:00. Both go to the people who manage AI, each in their own language. On unless an admin turned it
 * off (Admin › AI). No SMTP, no email.
 */
export async function sendWeeklyReports(d: Deps, mailer: Mailer, appUrl = env("APP_URL", "http://localhost:3000")): Promise<number> {
  if (!mailConfigured()) return 0;
  // No settings row yet means nobody turned it off: the email is opt-out.
  const row = (await d.pool.query<{ weekly_email: boolean }>("SELECT weekly_email FROM ai_report_settings")).rows[0];
  if (row && !row.weekly_email) return 0;
  try {
    return await runWithContext({ actorId: "service:ai-report", requestId: newId() }, () => sendReport(d, mailer, appUrl));
  } catch (err) {
    logger.warn({ err }, "weekly AI report failed");
    return 0;
  }
}

/** The first report is due once 7 days have passed since `since`, from 08:00 local on that day or later. */
export function firstDue(now: Date, timeZone: string, since: Date, firstSentAt: Date | null): boolean {
  if (firstSentAt || now.getTime() - since.getTime() < 7 * 86400_000) return false;
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hourCycle: "h23" }).format(now));
  return hour >= 8;
}

async function sendReport(d: Deps, mailer: Mailer, appUrl: string): Promise<number> {
  if (!(await aiFlags(d)).monitoring) return 0;
  await d.pool.query("INSERT INTO ai_report_settings (weekly_email) VALUES (true) ON CONFLICT (singleton) DO NOTHING");
  const { tz, last, since, firstSent } = await withTransaction(d.pool, async (c) => {
    const r = (
      await c.query<{ w: string | null; since: Date; first: Date | null }>(
        "SELECT to_char(last_sent_week, 'YYYY-MM-DD') AS w, since, first_sent_at AS first FROM ai_report_settings",
      )
    ).rows[0];
    return { tz: await workspaceTimeZone(c), last: r?.w ?? null, since: r?.since ?? new Date(), firstSent: r?.first ?? null };
  });
  const now = new Date();
  const first = firstDue(now, tz, since, firstSent);
  const { due, week } = weeklyDue(now, tz, last);
  if (!first && !due) return 0;
  // Claim first, so a slow send or a second replica never mails twice. The first report also counts as this week's.
  const claimed = await withTransaction(d.pool, (c) =>
    first
      ? c.query("UPDATE ai_report_settings SET first_sent_at = now(), last_sent_week = greatest(coalesce(last_sent_week, $1::date), $1::date) WHERE first_sent_at IS NULL", [week])
      : c.query("UPDATE ai_report_settings SET last_sent_week = $1 WHERE last_sent_week IS NULL OR last_sent_week < $1::date", [week]),
  );
  if (!claimed.rowCount) return 0;
  const holders = (await d.identity.request<{ userIds: string[] }>("GET", "/internal/holders/ai.policy.manage")).userIds;
  const emails = (await d.identity.request<{ emails: string[] }>("GET", "/internal/holders/ai.policy.manage/emails")).emails;
  if (!holders.length || !emails.length) return 0;
  const principal = await d.identity.request<Principal>("POST", "/internal/resolve", { userId: holders[0] });
  const report = await buildReport(d, principal, 7);
  const workspaceLang = await d.platform
    ?.request<{ locale?: string }>("GET", "/internal/workspace")
    .then((t) => t.locale)
    .catch(() => undefined);
  // Each person's own language (home keeps it), matched to their email through the member list.
  const members = await d.identity
    .request<{ members: { userId: string; email: string }[] }>("GET", "/members", undefined, principal)
    .then((r) => r.members)
    .catch(() => [] as { userId: string; email: string }[]);
  const idOf = new Map(members.map((m) => [m.email.toLowerCase(), m.userId]));
  const locales = await (d.home
    ?.request<{ locales: Record<string, string> }>("GET", `/internal/locales?ids=${encodeURIComponent(holders.join(","))}`)
    .then((r) => r.locales)
    .catch(() => ({})) ?? Promise.resolve({} as Record<string, string>));
  const mails = new Map<Lang, ReturnType<typeof reportEmail>>();
  for (const to of emails) {
    const lang = mailLang((locales as Record<string, string>)[idOf.get(to.toLowerCase()) ?? ""], workspaceLang);
    const mail = mails.get(lang) ?? reportEmail(report, lang, appUrl, first);
    mails.set(lang, mail);
    await mailer.send({ to, subject: mail.subject, html: mail.html, text: mail.text });
  }
  return emails.length;
}
