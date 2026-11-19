import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpException, Inject, Post, Query, Req } from "@nestjs/common";
import { z } from "zod";
import type { Request } from "express";
import { withTransaction, type Principal } from "@workspace/shared";
import { assertAllowed, requirePrincipal } from "@workspace/service-kit";
import { DEPS } from "./ai.controller.js";
import { aiAudience } from "./audience.js";
import { aiSinceSql, aiUsers } from "./metrics.js";
import { guardAi } from "./budgets.js";
import { helpfulScore } from "./capability.js";
import { classifyTopic, TOPICS, words, type Topic } from "./insight.js";
import type { TeamPerson } from "./progress-brief.js";
import { assistSystem } from "./prompts.js";
import { meteredGenerate, parseJson, replyLanguage, untrusted, type Deps } from "./runtime.js";

/**
 * AI › Áp dụng AI, the suggestions: which kinds of work people do a lot of without AI, where AI tends to help.
 * The kind of a task comes from its title with the same keyword topics as AI conversations (insight.ts), so the
 * work and the AI use line up without a model. Per topic: how many tasks, by whom, how many of those people used AI
 * for that kind of work in the window, and whether people who did say it helped. The model, when asked, turns the same
 * numbers and a few task titles into concrete ideas with a prompt to try.
 *
 * Who sees what: tasks as the caller's Follow-up shows them (their team, or their own work); AI use only for people
 * the caller may see in AI Insights (aiAudience), else only their own. "Helped" rates from outside that audience are
 * counted only over 5 or more people, so no one's ratings can be read off.
 */

export interface UseRow {
  userId: string;
  topic: string;
  conversations: number;
  rated: number;
  yes: number;
  partly: number;
}
export interface AdoptionPerson {
  userId: string;
  displayName: string;
  department?: string | null;
}
export interface Suggestion {
  topic: Topic;
  tasks: number;
  examples: string[];
  people: { userId: string; displayName: string; tasks: number; usesAi: boolean }[];
  departments: string[];
  /** Share of the people doing this work who used AI for it in the window (0–1). */
  coverage: number;
  /** Helpful share of rated AI conversations on this topic, when enough exist. */
  helpful: number | null;
  mentors: { userId: string; displayName: string; conversations: number; score: number }[];
  library: number;
  score: number;
}

const MIN_TASKS = { team: 3, self: 2 } as const;

/**
 * Task titles name work differently from prompts ("Fix flaky integration tests", "Runbook for incidents"): these rules
 * are tried first, then the prompts' own topics, so a task and a conversation about it still land on the same topic.
 */
const TASK_RULES: [Topic, RegExp][] = [
  [
    "code",
    words(
      String.raw`(fix|tests?|testing|kiểm thử|endpoints?|migrat\p{L}*|integration|webhooks?|crash\p{L}*|backend|front-?end|database|cache|sdk|android|ios|ci|pipeline|staging|failover|autoscal\p{L}*|deploy\p{L}*|release(?! notes?)|build|upgrade|cron|queue|driver|shortcuts?|sửa)`,
    ),
  ],
  ["writing", words(String.raw`(docs?|documentation|runbook|guide|handbook|hướng dẫn|release notes?|announcement|newsletter|blog|tài liệu|bài viết|quy trình)`)],
  ["sales", words(String.raw`(renewal|demo|discovery|follow up|sponsor|case study|testimonial|webinar|pricing|order form|deal|gia hạn|chăm sóc khách)`)],
  [
    "analysis",
    words(
      String.raw`(dashboard|metrics?|report(ing)?|báo cáo|thống kê|audit|survey|khảo sát|budget|ngân sách|actuals|reconciliation|đối soát|vat|payroll|forecast|board pack|invoices?|hoá đơn|payment run)`,
    ),
  ],
  ["hr", words(String.raw`(train(ing)?|đào tạo)`)],
  ["planning", words(String.raw`(plan(ning)?|roadmap|sprint|retro\p{L}*|estimate|ước lượng|drill|cut-?over|timeline|lịch)`)],
  ["design", words(String.raw`(mockups?|wireframes?|prototype|ux|ui|figma|banner|storybook)`)],
];
export function classifyTask(title: string): Topic {
  for (const [topic, re] of TASK_RULES) if (re.test(title)) return topic;
  return classifyTopic(title);
}
const MIN_RATERS = 5;

export function adoptionSuggestions(
  scope: "team" | "self",
  people: AdoptionPerson[],
  tasks: { userId: string; title: string; ai?: boolean }[],
  use: UseRow[],
  library: Partial<Record<string, number>>,
  wide: Partial<Record<string, { raters: number; rated: number; yes: number; partly: number }>> = {},
) {
  const names = new Map(people.map((x) => [x.userId, x]));
  const byTopic = new Map<Topic, { userId: string; title: string; ai?: boolean }[]>();
  for (const t of tasks) {
    const topic = classifyTask(t.title);
    if (topic === "other") continue;
    byTopic.set(topic, [...(byTopic.get(topic) ?? []), t]);
  }
  const usedBy = new Map<string, Set<string>>();
  for (const u of use) if (u.conversations > 0) usedBy.set(u.topic, (usedBy.get(u.topic) ?? new Set()).add(u.userId));
  const topics = TOPICS.filter((t) => t !== "other").map((topic) => {
    const list = byTopic.get(topic) ?? [];
    const doers = [...new Set(list.map((t) => t.userId))];
    // Someone uses AI for this kind of work when their AI conversations are about it, or when AI helped with one of
    // their tasks of this kind (the company AI on the task, or a conversation linked to it).
    const ai = new Set([...(usedBy.get(topic) ?? []), ...list.filter((t) => t.ai).map((t) => t.userId)]);
    const rows = use.filter((u) => u.topic === topic);
    const own = rows.reduce((a, u) => ({ rated: a.rated + u.rated, yes: a.yes + u.yes, partly: a.partly + u.partly }), { rated: 0, yes: 0, partly: 0 });
    const w = wide[topic];
    // The caller's own audience first; the company-wide rate only when it covers enough people.
    const helpful = own.rated >= 3 ? helpfulScore(own) : w && w.raters >= MIN_RATERS && w.rated >= 3 ? helpfulScore(w) : null;
    return {
      topic,
      tasks: list.length,
      people: doers.length,
      aiPeople: doers.filter((u) => ai.has(u)).length,
      coverage: doers.length ? doers.filter((u) => ai.has(u)).length / doers.length : 0,
      helpful,
      list,
      doers,
      ai,
      rows,
    };
  });
  const suggestions: Suggestion[] = topics
    .filter((x) => x.tasks >= MIN_TASKS[scope] && x.coverage < 0.6)
    .map((x) => {
      const counts = new Map<string, number>();
      for (const t of x.list) counts.set(t.userId, (counts.get(t.userId) ?? 0) + 1);
      const weight = x.helpful === null ? 1 : 0.5 + x.helpful;
      // Mentors are colleagues the caller may see who use AI for this kind of work and say it helps.
      const mentors =
        scope === "team"
          ? x.rows
              .filter((u) => u.conversations >= 3 && u.rated >= 2 && (helpfulScore(u) ?? 0) >= 0.7 && names.has(u.userId))
              .sort((a, b) => b.conversations - a.conversations)
              .slice(0, 2)
              .map((u) => ({ userId: u.userId, displayName: names.get(u.userId)!.displayName, conversations: u.conversations, score: helpfulScore(u)! }))
          : [];
      return {
        topic: x.topic,
        tasks: x.tasks,
        // Examples are work AI has not helped with yet.
        examples: [...new Set(x.list.filter((t) => !t.ai).map((t) => t.title))].slice(0, 3),
        people: [...counts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 8)
          .map(([userId, n]) => ({ userId, displayName: names.get(userId)?.displayName ?? "", tasks: n, usesAi: x.ai.has(userId) })),
        departments: [...new Set(x.doers.map((u) => names.get(u)?.department).filter((d): d is string => !!d))].slice(0, 4),
        coverage: Math.round(x.coverage * 100) / 100,
        helpful: x.helpful === null ? null : Math.round(x.helpful * 100) / 100,
        mentors,
        library: library[x.topic] ?? 0,
        score: Math.round(x.tasks * (1 - x.coverage) * weight * 100) / 100,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  return {
    topics: topics.filter((x) => x.tasks > 0).map(({ topic, tasks, people, aiPeople, coverage, helpful }) => ({ topic, tasks, people, aiPeople, coverage, helpful })),
    suggestions,
  };
}

export interface AdoptionIdea {
  title: string;
  topic: string;
  who: string;
  how: string;
  prompt: string;
}
const clip = (s: unknown, n: number) => (typeof s === "string" ? s.trim().slice(0, n) : "");

/**
 * The caller's own open work AI has not helped with yet, most urgent first, each with its kind: the "do it with AI
 * now" list. AI help is known only when it is recorded on the task (work's task_ai_assists: the company AI used on
 * it, or an AI conversation linked to it); `assisted` counts the open tasks left out for that reason.
 */
export function myTasks(tasks: { id: string; code: string; title: string; status: string; dueAt: string | null; overdue?: boolean; aiAssists?: number }[], limit = 6) {
  const all = tasks.filter((t) => t.status !== "done");
  const open = all.filter((t) => !t.aiAssists).map((t) => ({ id: t.id, code: t.code, title: t.title, dueAt: t.dueAt, overdue: !!t.overdue, topic: classifyTask(t.title) }));
  const rank = (t: (typeof open)[number]) => (t.overdue ? 0 : t.dueAt ? 1 : 2);
  // Work AI can help with first (a known kind), then by urgency; "other" fills the list only when little else is open.
  const list = open
    .sort((a, b) => Number(a.topic === "other") - Number(b.topic === "other") || rank(a) - rank(b) || (a.dueAt ?? "9").localeCompare(b.dueAt ?? "9"))
    .slice(0, limit);
  return { list, assisted: all.length - open.length };
}

/**
 * How far each person has taken AI in the window: their AI conversations (only for people the caller may see in AI
 * Insights, else zero) plus the tasks AI helped with. 0 = not at all, 1 = now and then (under 10), 2 = regularly.
 */
export function teamAdoption(people: TeamPerson[], use: Pick<UseRow, "userId" | "conversations">[], users?: Set<string>) {
  const conv = new Map<string, number>();
  for (const u of use) conv.set(u.userId, (conv.get(u.userId) ?? 0) + u.conversations);
  const rows = people.map((x) => {
    const conversations = conv.get(x.userId) ?? 0;
    const aiTasks = x.tasks.filter((t) => t.aiAssists).length;
    const n = conversations + aiTasks;
    // "Uses AI" is the shared definition (metrics.ts usesAi) when given, so this count matches Usage and the report.
    const using = users ? users.has(x.userId) : n > 0;
    return { userId: x.userId, displayName: x.displayName, department: x.department ?? null, conversations, aiTasks, level: !using ? 0 : n < 10 ? 1 : 2 };
  });
  const departments = new Map<string, { name: string | null; people: number; using: number }>();
  for (const r of rows) {
    const d = departments.get(r.department ?? "") ?? { name: r.department, people: 0, using: 0 };
    d.people++;
    if (r.level) d.using++;
    departments.set(r.department ?? "", d);
  }
  return {
    people: rows.length,
    using: rows.filter((r) => r.level).length,
    regular: rows.filter((r) => r.level === 2).length,
    departments: [...departments.values()].sort((a, b) => Number(a.name === null) - Number(b.name === null) || b.people - a.people),
    rows: rows.sort((a, b) => b.conversations + b.aiTasks - (a.conversations + a.aiTasks) || a.displayName.localeCompare(b.displayName)),
  };
}

/** The team's open work AI has not helped with yet (the caller's own are listed as theirs), each with its assignee. */
export function teamOpenTasks(people: TeamPerson[], self: string, limit = 12) {
  return people
    .filter((x) => x.userId !== self)
    .flatMap((x) => myTasks(x.tasks, limit).list.map((t) => ({ ...t, assigneeId: x.userId, assignee: x.displayName })))
    .sort((a, b) => Number(a.topic === "other") - Number(b.topic === "other") || Number(b.overdue) - Number(a.overdue) || (a.dueAt ?? "9").localeCompare(b.dueAt ?? "9"))
    .slice(0, limit);
}

@Controller()
export class AdoptionController {
  constructor(@Inject(DEPS) private readonly d: Deps) {}

  private async load(p: Principal, days: number) {
    const work = this.d.services.work;
    const [team, me] = await Promise.all([
      work.request<{ scope?: string; people: TeamPerson[] }>("GET", "/followup/team", undefined, p),
      work.request<{ me: TeamPerson | null }>("GET", "/followup/me", undefined, p),
    ]);
    let scope: "team" | "self" = "team";
    let people: TeamPerson[] = team.scope !== "none" ? team.people : [];
    if (!people.length) {
      scope = "self";
      people = me.me ? [{ ...me.me, userId: p.id, displayName: me.me.displayName || "" }] : [];
    }
    const { list: mine, assisted } = myTasks(me.me?.tasks ?? []);
    // AI use only for the people the caller may see in AI Insights; without that right, only their own.
    const visible = new Set<string>([p.id]);
    if (scope === "team")
      try {
        for (const x of (await aiAudience(this.d, p)).people) visible.add(x.userId);
      } catch (e) {
        if (!(e instanceof ForbiddenException)) throw e;
      }
    // The team's head count is the AI audience's (as on Usage and in the weekly report): people the follow-up view
    // leaves out (no tasks, the caller) still count, with no tasks of their own here.
    if (scope === "team" && visible.size > 1) {
      const seen = new Set(people.map((x) => x.userId));
      const dir = (await aiAudience(this.d, p).catch(() => ({ people: [] as { userId: string; displayName: string; department?: string | null }[] }))).people;
      people = [
        ...people,
        ...dir
          .filter((x) => !seen.has(x.userId))
          .map((x) => ({ userId: x.userId, displayName: x.displayName, department: x.department ?? null, tasks: [] }) as unknown as TeamPerson),
      ];
    }
    const ids = people.map((x) => x.userId).filter((id) => visible.has(id));
    return withTransaction(this.d.pool, async (c) => {
      const users = await aiUsers(c, ids, days);
      const use = (
        await c.query<UseRow>(
          `SELECT user_id AS "userId", topic, count(*)::int AS conversations, count(helpful)::int AS rated,
                  count(*) FILTER (WHERE helpful = 'yes')::int AS yes, count(*) FILTER (WHERE helpful = 'partly')::int AS partly
             FROM ai_conversations
            WHERE user_id = ANY($1::text[]) AND last_at > ${aiSinceSql(days)} AND source <> 'import'
            GROUP BY user_id, topic`,
          [ids],
        )
      ).rows;
      const wide = Object.fromEntries(
        (
          await c.query<{ topic: string; raters: number; rated: number; yes: number; partly: number }>(
            `SELECT topic, count(DISTINCT user_id)::int AS raters, count(*)::int AS rated,
                    count(*) FILTER (WHERE helpful = 'yes')::int AS yes, count(*) FILTER (WHERE helpful = 'partly')::int AS partly
               FROM ai_conversations WHERE helpful IS NOT NULL AND last_at > now() - make_interval(days => $1) GROUP BY topic`,
            [days],
          )
        ).rows.map((r) => [r.topic, r]),
      );
      const library = Object.fromEntries(
        (
          await c.query<{ topic: string; n: number }>(`SELECT topic, count(*)::int AS n FROM ai_prompt_library WHERE status = 'live' AND visibility <> 'private' GROUP BY topic`)
        ).rows.map((r) => [r.topic, r.n]),
      );
      // The caller's own AI use: the last 7 days by day, the tasks AI helped with and how often it helped.
      const own = (
        await c.query<{ day: string; n: number }>(
          `SELECT d::date::text AS day, count(c.id)::int AS n
             FROM generate_series(current_date - 6, current_date, interval '1 day') d
             LEFT JOIN ai_conversations c ON c.user_id = $1 AND c.source <> 'import' AND c.last_at::date = d::date
            GROUP BY d ORDER BY d`,
          [p.id],
        )
      ).rows;
      const totals = (
        await c.query<{ conversations: number; tasks: number; rated: number; yes: number; partly: number; topics: string[] }>(
          `SELECT count(*)::int AS conversations, count(DISTINCT task_id)::int AS tasks, count(helpful)::int AS rated,
                  count(*) FILTER (WHERE helpful = 'yes')::int AS yes, count(*) FILTER (WHERE helpful = 'partly')::int AS partly,
                  coalesce(array_agg(DISTINCT topic), '{}') AS topics
             FROM ai_conversations WHERE user_id = $1 AND source <> 'import' AND last_at > now() - make_interval(days => $2)`,
          [p.id, days],
        )
      ).rows[0]!;
      const tasks = people.flatMap((x) => x.tasks.map((t) => ({ userId: x.userId, title: t.title, ai: !!t.aiAssists })));
      return {
        scope,
        people,
        mine,
        // With the AI audience in view, the same people and definition as Usage; otherwise as before (tasks AI helped).
        team:
          visible.size > 1
            ? teamAdoption(
                people.filter((x) => visible.has(x.userId)),
                use,
                users,
              )
            : teamAdoption(people, use),
        teamTasks: scope === "team" ? teamOpenTasks(people, p.id) : [],
        me: {
          assisted,
          week: own.map((r) => r.n),
          conversations: totals.conversations,
          tasks: totals.tasks,
          helpful: totals.rated >= 3 ? Math.round((helpfulScore(totals) ?? 0) * 100) / 100 : null,
          topics: totals.topics.filter((t) => t !== "other"),
        },
        ...adoptionSuggestions(scope, people, tasks, use, library, wide),
      };
    });
  }

  @Get("adoption/suggestions")
  async suggestions(@Req() req: Request, @Query("days") daysQ?: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "task.read");
    const days = [7, 30, 90].includes(Number(daysQ)) ? Number(daysQ) : 30;
    const r = await this.load(p, days);
    return { days, scope: r.scope, people: r.people.length, topics: r.topics, suggestions: r.suggestions, mine: r.mine, me: r.me, team: r.team, teamTasks: r.teamTasks };
  }

  @Post("adoption/analyze")
  async analyze(@Req() req: Request, @Query("days") daysQ?: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "ai.use");
    const lang = replyLanguage(req);
    const days = [7, 30, 90].includes(Number(daysQ)) ? Number(daysQ) : 30;
    return guardAi(async () => {
      const r = await this.load(p, days);
      const facts = {
        scope: r.scope,
        people: r.people.length,
        topics: r.topics,
        suggestions: r.suggestions.map((s) => ({
          topic: s.topic,
          tasks: s.tasks,
          coverage: s.coverage,
          helpful: s.helpful,
          departments: s.departments,
          mentors: s.mentors.map((m) => m.displayName),
        })),
      };
      // A sample of what people actually work on, so ideas name real work; titles are typed by people (untrusted).
      const titles = [...new Set(r.people.flatMap((x) => x.tasks.map((t) => `- ${t.title}`)))].slice(0, 80).join("\n");
      const shape = `{"summary": string, "ideas": [{"title": string, "topic": string, "who": string, "how": string, "prompt": string}]}`;
      const extra = `You advise ${r.scope === "team" ? "a manager on how their team" : "one person on how they"} could use AI in their everyday work. summary: 2-3 sentences on where AI could save the most time, grounded in the numbers. ideas: 3-5 concrete ideas, most valuable first; title = short imperative; topic = one of ${TOPICS.join(", ")}; who = which people or departments (from the facts; empty for one person); how = 2-3 sentences on how to do it with an AI chat assistant, including how to check the result; prompt = a ready-to-paste prompt with [placeholders] for the details. Never suggest sending personal ID numbers, salaries, passwords or customer contact lists to AI.`;
      const out = await meteredGenerate(
        this.d,
        { principal: p, agentId: null, feature: "adoption_ideas" },
        {
          tier: "fast",
          system: assistSystem(lang, "adoption_ideas", shape, extra),
          maxTokens: 1800,
          messages: [{ role: "user", content: `<facts>${JSON.stringify(facts)}</facts>\n${titles ? untrusted(titles) : ""}` }],
        },
      );
      const raw = parseJson<{ summary?: unknown; ideas?: Partial<AdoptionIdea>[] }>(out.text);
      if (!raw) throw new HttpException({ error: "ai_malformed_output" }, 502);
      return {
        summary: clip(raw.summary, 1000),
        ideas: (Array.isArray(raw.ideas) ? raw.ideas : []).slice(0, 5).map((i) => ({
          title: clip(i.title, 160),
          topic: (TOPICS as readonly string[]).includes(String(i.topic)) ? String(i.topic) : "other",
          who: clip(i.who, 200),
          how: clip(i.how, 800),
          prompt: clip(i.prompt, 1500),
        })),
      };
    });
  }

  /**
   * "Tạo prompt": a prompt for one of the caller's tasks, written only when they ask for it. The model reads the
   * task as the caller sees it (title and description are people's text, so untrusted) and writes a ready-to-paste
   * prompt for any AI chat, with [placeholders] for what it cannot know. Not recorded against the task: asking for a
   * prompt is not yet AI helping with the work.
   */
  @Post("adoption/prompt")
  async prompt(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "ai.use");
    const b = z.object({ taskId: z.string().min(1).max(40) }).safeParse(body);
    if (!b.success) throw new BadRequestException("invalid request");
    const lang = replyLanguage(req);
    return guardAi(async () => {
      const t = await this.d.services.work.request<{ task: { code: string; title: string; description: string; status: string; dueAt: string | null } }>(
        "GET",
        `/tasks/${b.data.taskId}`,
        undefined,
        p,
      );
      const facts = { code: t.task.code, title: t.task.title, topic: classifyTask(t.task.title), status: t.task.status, dueAt: t.task.dueAt };
      const shape = `{"prompt": string}`;
      const extra =
        "Write one ready-to-paste prompt the person can give an AI chat assistant (ChatGPT, Claude, the company's AI) to get real help with this task: say what the task is, what to produce, the format, and how to check it; use [placeholders] for details you do not know. 60-140 words, in the person's language, no preamble. Never ask them to paste personal ID numbers, salaries, passwords or customer contact lists.";
      const r = await meteredGenerate(
        this.d,
        { principal: p, agentId: null, feature: "adoption_prompt" },
        {
          tier: "fast",
          system: assistSystem(lang, "adoption_prompt", shape, extra),
          maxTokens: 500,
          messages: [{ role: "user", content: `<facts>${JSON.stringify(facts)}</facts>\n${untrusted(`${t.task.title}\n\n${t.task.description ?? ""}`.slice(0, 4000))}` }],
        },
      );
      const raw = parseJson<{ prompt?: unknown }>(r.text);
      const prompt = clip(raw?.prompt, 2000);
      if (!prompt) throw new HttpException({ error: "ai_malformed_output" }, 502);
      return { prompt };
    });
  }
}
