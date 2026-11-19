/**
 * Eight weeks of AI Insights history for the demo workspace (seed-demo.mjs): what each person used AI for, on which
 * tool, whether it helped, which task it served, sensitive data that was warned about, redacted or blocked, and the
 * company AI's cost. The extension intake only takes the last seven days and never backdates tasks, so this part is
 * written straight into the database in one transaction, after everything else went through the public API.
 *
 * Deterministic: a fixed PRNG seed gives the same story on every run (the hourly demo reset restores a snapshot
 * anyway). Nothing here needs an AI provider.
 */

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";

/** mulberry32: small, fast, and the same sequence everywhere. */
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** A ULID-shaped id (the format newId() makes), time-ordered like real rows. */
function ulid(rand, ms) {
  let time = "";
  for (let i = 9, t = ms; i >= 0; i--, t = Math.floor(t / 32)) time = CROCKFORD[t % 32] + time;
  let tail = "";
  for (let i = 0; i < 16; i++) tail += CROCKFORD[Math.floor(rand() * 32)];
  return time + tail;
}

/** SQL literal for the generated script (no parameters: the same text runs through pg or psql). */
export function lit(v) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v instanceof Date) return `'${v.toISOString()}'::timestamptz`;
  if (Array.isArray(v)) return v.length ? `ARRAY[${v.map(lit).join(",")}]::text[]` : "'{}'::text[]";
  return `'${String(v).replace(/'/g, "''")}'`;
}
const row = (values) => `(${values.map(lit).join(", ")})`;

/** Prompts by topic, as people type them. */
const PROMPTS = {
  code: [
    "Explain TypeError: Cannot read properties of undefined in React",
    "Write a debounce function in TypeScript with cancel support",
    "Optimise this SQL query, it takes 4 seconds on the orders table",
    "Review this payment webhook handler, any security holes?",
    "How do I mock a fetch call in a unit test for a React hook?",
    "Write unit tests for the shipping fee calculator",
    "Terraform module for a private S3 bucket with versioning",
    "Refactor the cart component for readability",
    "Why does this Kotlin coroutine leak when the screen rotates?",
    "Write a Playwright test for the checkout flow",
  ],
  writing: [
    "Write a thank-you email to a customer after the product demo",
    "Draft an internal announcement about the holiday schedule",
    "Summarise these stand-up notes into 5 bullet points",
    "Rewrite this release note so customers understand it",
    "Rewrite this product description to be shorter and clearer",
    "Draft a QA Engineer job post for the careers page",
    "Turn these meeting notes into a decision log",
  ],
  analysis: [
    "Spreadsheet formula for the monthly churn rate",
    "Analyse Q3 revenue by sales channel",
    "Build a pivot from the attendance sheet to see overtime by team",
    "Forecast next quarter's sign-ups from these monthly numbers",
    "Compare conversion rates between two versions of the sign-up page",
    "Explain the variance between budget and actuals in this table",
  ],
  translation: ["Translate the product one-pager into German", "Translate this email into French, polite tone", "Translate the onboarding checklist into Spanish"],
  research: [
    "Compare SEPA Direct Debit providers for a B2B SaaS",
    "What changed in the EU AI Act for workplace tools?",
    "What is the difference between OAuth and OIDC?",
    "Summarise the SOC 2 trust services criteria in plain English",
    "Which help desk tools support WhatsApp Business natively?",
  ],
  sales: [
    "Draft a proposal for onboarding and training for a mid-market customer",
    "Cold-call script for a retail chain",
    "How to negotiate when the client asks for a 20% discount",
    "Write a short business case for a 12-month contract",
    "Objection handling: 'we already use spreadsheets'",
  ],
  hr: [
    "Write a job description for a Backend Engineer with 3 years' experience",
    "Interview questions for Account Executive candidates",
    "First-week onboarding checklist for new hires",
    "End-of-probation review template",
    "Draft a fair remote-work policy for a two-month trial",
  ],
  design: [
    "Suggest a colour palette for the summit banner",
    "Review the UX of the app sign-up flow, any redundant steps?",
    "Icon ideas for the contract renewal reminder",
    "Microcopy for an empty state in the billing page",
  ],
  planning: [
    "Plan the app launch over 6 weeks, week by week",
    "Write Q4 OKRs for the Sales department",
    "Prioritise these 10 tasks by impact and effort",
    "Payments roadmap for the next two quarters",
    "Agenda for a one-day leadership offsite",
  ],
  // The company's own topics (Admin › AI › Topics), below.
  c_quotes: [
    "Check the payment terms in the master services agreement before sending it",
    "Draft a 12-month renewal addendum keeping the unit price",
    "Draft a quote follow-up email after the client asked for a discount",
  ],
  c_payments: [
    "Explain how SEPA transactions are reconciled against the bank statement",
    "Write a test checklist for partial refunds",
    "Why would a payment webhook arrive twice and how do we make it idempotent?",
  ],
  c_launch: ["Write the app store description, 4000 characters max", "Launch-day checklist: communication, support, error monitoring"],
  c_campaigns: [
    "Five headline options for the Customer Summit landing page",
    "Write a LinkedIn post announcing the new website",
    "Email sequence for webinar sign-ups who didn't attend",
    "SEO outline for 'project management for operations teams'",
  ],
  c_support: [
    "Reply to a customer whose invoice was charged twice, apologetic but brief",
    "Turn this bug report into steps to reproduce for engineering",
    "Help article: how to set up SSO with Okta",
    "Customer is angry about downtime, draft a calm reply with next steps",
  ],
  c_close: ["Checklist for a five-day month-end close", "Explain deferred revenue for annual plans paid upfront", "Accruals journal for October from this list"],
};

/** The company's own topics (ai_topics): key, labels, the keywords the classifier tries first. */
const COMPANY_TOPICS = [
  ["c_quotes", "Báo giá & hợp đồng", "Quotes & contracts", ["quote", "contract", "proposal", "addendum", "renewal", "msa"]],
  ["c_payments", "Thanh toán & đối soát", "Payments & reconciliation", ["reconcile", "sepa", "refund", "webhook", "payment"]],
  ["c_launch", "Ra mắt ứng dụng", "App launch", ["app store", "launch"]],
  ["c_campaigns", "Chiến dịch & nội dung", "Campaigns & content", ["headline", "linkedin", "campaign", "seo", "webinar", "newsletter"]],
  ["c_support", "Trả lời khách hàng", "Customer replies", ["customer", "ticket", "help article", "reply"]],
  ["c_close", "Khoá sổ cuối tháng", "Month-end close", ["month-end", "accrual", "deferred revenue", "close"]],
];

/** Words that must not leave the company (ai_keywords): fictional clients and project codes, [term, label]. */
const COMPANY_KEYWORDS = [
  ["Lakeshore Logistics", "Design partner"],
  ["workspace-bot", "Release bot"],
];

/** The library prompts that are the company's own templates (the rest are personal, shared with everyone). */
const COMPANY_PROMPTS = ["One-page PRD template", "Campaign brief in ten lines", "Launch post without hype", "Explain a stack trace"];

/** Shared prompts (ai_prompt_library), already redacted: [author, topic, title, body, uses]. */
const LIBRARY = [
  [
    "minh",
    "code",
    "Explain a stack trace",
    "Here is a stack trace from production. Explain the root cause in two sentences, then list the three most likely fixes, most likely first. Ask me for the file if you need it.\n\n[paste stack trace]",
    51,
  ],
  [
    "anh",
    "code",
    "Keep a route under the JS budget",
    "The route below is over 200 KB gzip. List what to lazy-load first and why, without breaking SSR. Paste the import graph if you need it.\n\n[paste]",
    28,
  ],
  [
    "phong",
    "code",
    "Test cases from a spec",
    "From the spec below, list test cases as a table: step, data, expected result. Add 3 edge cases that are easy to miss.\n\n[paste spec]",
    38,
  ],
  [
    "phong",
    "writing",
    "One-page PRD template",
    "Write a one-page PRD for [feature]: problem, users, measurable goals, scope (in / out), risks, open questions. Short sentences, no marketing.",
    45,
  ],
  [
    "trinh",
    "c_campaigns",
    "Campaign brief in ten lines",
    "Write a campaign brief for [campaign]: audience, one message, proof points, channels, call to action, success metric, budget, dates. Ten lines, no fluff.",
    24,
  ],
  [
    "trinh",
    "c_launch",
    "Launch post without hype",
    "Rewrite the launch post below for engineering teams who self-host. No superlatives, every claim from the fact sheet. Under 500 words.\n\n[paste draft]",
    19,
  ],
  [
    "quang",
    "code",
    "Review a release script",
    "Review the release script below. Point out: secrets in logs, non-idempotent steps, missing rollback. Answer as a table: issue, severity, fix.\n\n[paste]",
    22,
  ],
];

/** Topics each department leans to (repeats weigh them). */
const DEPT_TOPICS = {
  eng: ["code", "code", "code", "research", "writing", "analysis", "c_launch"],
  growth: ["writing", "c_campaigns", "c_launch", "planning", "analysis", "design"],
  owner: ["planning", "analysis", "writing", "research", "c_launch"],
};

/** The named people's habits: tools they reach for, conversations per week at the end of the 8 weeks, share found helpful. */
const CORE_HABITS = {
  owner: { tools: ["chatgpt", "claude", "company"], perWeek: 4, yes: 0.75 },
  minh: { tools: ["claude", "chatgpt", "company", "copilot"], perWeek: 7, yes: 0.8 },
  anh: { tools: ["chatgpt", "copilot", "claude"], perWeek: 6, yes: 0.78 },
  quang: { tools: ["chatgpt", "claude", "copilot"], perWeek: 5, yes: 0.72 },
  trinh: { tools: ["claude", "chatgpt", "company"], perWeek: 6, yes: 0.82 },
  phong: { tools: ["gemini", "chatgpt", "company"], perWeek: 4, yes: 0.7 },
};
/** Everyone else, by department (unused for the six-person Workspace seed; kept for a larger company later). */
const DEPT_HABITS = {
  eng: { share: 0.9, perWeek: [3, 8], tools: ["chatgpt", "copilot", "claude", "gemini"] },
  growth: { share: 0.9, perWeek: [3, 7], tools: ["claude", "chatgpt", "company", "gemini"] },
};

const FOLLOW_UPS = [
  "Can you make it shorter?",
  "Add a concrete example",
  "Rewrite it in a more formal tone",
  "Make it shorter",
  "Explain the second step in detail",
  "Turn it into a table",
];

/** Prompts that carried sensitive data, as stored after the safety net: redacted ones keep only the placeholders. */
const SENSITIVE = [
  [
    "quang",
    {
      kinds: ["secret", "keyword", "contacts"],
      prompt: "Why does our release job fail to push the image? docker login ghcr.io -u workspace-bot -p [SECRET] returns denied. First reported by [KEYWORD] ([EMAIL]).",
      topic: "code",
    },
  ],
  ["trinh", { kinds: ["contacts"], prompt: "Draft a launch invite list: [EMAIL], [EMAIL], [PHONE]…", topic: "c_campaigns" }],
  ["minh", { kinds: ["secret"], prompt: "Why does the staging deploy return 401 with the key [SECRET]?", topic: "code" }],
];
const SAFETY_SPREAD = [
  ["quang", "redact", ["secret"]],
  ["quang", "block", ["secret"]],
  ["quang", "redact", ["contacts"]],
  ["trinh", "redact", ["contacts"]],
  ["trinh", "warn", ["contacts"]],
  ["minh", "warn", ["secret"]],
  ["anh", "warn", ["contacts"]],
  ["phong", "redact", ["contacts"]],
];
const taskPrompt = (title) => `${title}: the fastest approach and what to double-check`;
const hintPrompt = (title) => `${title}: integration steps and common pitfalls`;
const ERASURE_NOTE = "I'd like my old conversations deleted before I move to the new project.";

/** Company-AI features and the share of calls each takes, with the tokens a call typically uses. */
const COMPANY_FEATURES = [
  ["assistant", 0.34, 2400, 700],
  ["task_description", 0.12, 900, 400],
  ["task_subtasks", 0.1, 800, 350],
  ["summarize", 0.12, 3000, 300],
  ["doc_draft", 0.1, 1500, 1200],
  ["translate", 0.1, 1200, 1200],
  ["extract_meeting", 0.06, 4000, 500],
  ["thread_summary", 0.06, 2500, 250],
];
const COMPANY_MODELS = [
  ["openai", "gpt-4.1-mini", 0.4, 1.6, 0.65],
  ["anthropic", "claude-haiku-4-5", 1, 5, 0.35],
];

const SOURCE_URL = {
  chatgpt: "https://chatgpt.com/c/",
  claude: "https://claude.ai/chat/",
  gemini: "https://gemini.google.com/app/",
  copilot: "https://copilot.microsoft.com/chats/",
  perplexity: "https://www.perplexity.ai/search/",
  deepseek: "https://chat.deepseek.com/a/chat/s/",
};

/**
 * The SQL for the whole AI Insights story.
 *  - people: { key, dept, userId } for every member and the owner (dept "owner" for the owner);
 *  - tasks: done tasks the seed made, { id, assignee } (assignee is a person key);
 *  - openTasks: tasks still in progress, for the staff demo user's pending extension hints;
 *  - deptIds: department key → employee department id;
 */
export function aiInsightsSql({ people, tasks, openTasks, deptIds, staffKey = "minh", now = Date.now() }) {
  const rand = prng(20261025);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const DAY = 86400_000;
  const byKey = new Map(people.map((p) => [p.key, p]));
  // Who uses AI and how much: the named people as written, everyone else drawn per department. Some never do,
  // which is what makes the "with AI / without AI" comparison mean something.
  const HABITS = {};
  for (const p of people) {
    if (CORE_HABITS[p.key]) HABITS[p.key] = CORE_HABITS[p.key];
    else {
      const d = DEPT_HABITS[p.dept];
      if (!d || rand() > d.share) continue;
      const tools = [pick(d.tools), pick(d.tools), pick(d.tools)];
      HABITS[p.key] = { tools, perWeek: d.perWeek[0] + Math.floor(rand() * (d.perWeek[1] - d.perWeek[0] + 1)), yes: 0.5 + rand() * 0.35 };
    }
  }
  const out = [];
  const convs = [];
  const messages = [];
  const usage = [];

  // Work: done tasks spread over the 8 weeks. Tasks AI helped with go from created to done in about 1–2.5 days,
  // the others in 2–6: the gap the "AI có giúp làm việc tốt hơn?" card shows, which is what the demo is about.
  const assisted = new Set();
  const taskTimes = new Map();
  tasks.forEach((t) => {
    // Heavier AI users get help on more of their work; people who don't use AI never do.
    const habit = HABITS[t.assignee];
    const helped = Boolean(habit) && rand() < Math.min(0.85, 0.25 + habit.perWeek * 0.08);
    if (helped) assisted.add(t.id);
    // Three in four within the last 30 days (the default window of Công việc › AI, which compares only with 20+ tasks
    // per side), the rest back to week 8 for the trend.
    const daysAgo = rand() < 0.75 ? Math.floor(rand() * 29 + 1) : Math.floor(rand() * 25 + 30);
    const done = now - daysAgo * DAY - Math.floor(rand() * 8) * 3600_000;
    const cycle = (helped ? 0.8 + rand() * 1.7 : 2 + rand() * 4) * DAY;
    const created = done - cycle;
    // Mostly on time, the helped ones a bit more often.
    const due = done + (rand() < (helped ? 0.85 : 0.65) ? 1 : -1) * Math.floor(rand() * 3 + 1) * DAY;
    taskTimes.set(t.id, { created, done });
    out.push(
      `UPDATE work.tasks SET created_at = ${lit(new Date(created))}, completed_at = ${lit(new Date(done))}, updated_at = ${lit(new Date(done))}, due_at = ${lit(new Date(due))} WHERE id = ${lit(t.id)};`,
    );
  });

  const addConversation = (c) => {
    convs.push(c);
    const turns = c.turns ?? 1 + Math.floor(rand() * 3);
    for (let i = 0; i < turns; i++) {
      const at = new Date(c.startedAt + i * (3 + Math.floor(rand() * 10)) * 60_000);
      messages.push([ulid(rand, at.getTime()), c.id, "user", i === 0 ? c.prompt : pick(FOLLOW_UPS), at]);
    }
    c.messages = turns;
    c.lastAt = c.startedAt + (turns - 1) * 8 * 60_000;
  };
  const helpfulFor = (key) => {
    if (rand() > 0.78) return null; // not everyone taps
    const r = rand();
    const yes = HABITS[key].yes;
    return r < yes ? "yes" : r < yes + (1 - yes) * 0.6 ? "partly" : "no";
  };

  // Everyday use: grows over the 8 weeks (the trend the owner looks for), weekdays, office hours.
  for (const p of people) {
    const habit = HABITS[p.key];
    if (!habit) continue;
    for (let w = 7; w >= 0; w--) {
      const n = Math.max(0, Math.round(habit.perWeek * (0.45 + ((7 - w) / 7) * 0.55) + (rand() - 0.5) * 2));
      for (let i = 0; i < n; i++) {
        const startedAt = now - w * 7 * DAY - Math.floor(rand() * 5) * DAY - Math.floor(rand() * 9 + 1) * 3600_000;
        if (startedAt > now - 600_000) continue;
        const topic = pick(DEPT_TOPICS[p.dept] ?? DEPT_TOPICS.owner);
        const source = pick(habit.tools);
        const prompt = pick(PROMPTS[topic]);
        const helpful = helpfulFor(p.key);
        addConversation({ id: ulid(rand, startedAt), userId: p.userId, key: p.key, source, topic, prompt, startedAt, helpful, sensitive: [] });
      }
    }
  }

  // One conversation per helped task, by the person who did it, shortly after they started it; linked the three ways.
  const LINKS = ["manual", "hint", "hint", "suggested", "manual"];
  let li = 0;
  for (const t of tasks) {
    if (!assisted.has(t.id)) continue;
    const p = byKey.get(t.assignee);
    if (!p || !HABITS[p.key]) continue;
    const { created } = taskTimes.get(t.id);
    const startedAt = created + (1 + Math.floor(rand() * 5)) * 3600_000;
    const habit = HABITS[p.key];
    const topic = pick(DEPT_TOPICS[p.dept] ?? DEPT_TOPICS.owner);
    const source = pick(habit.tools.filter((s) => s !== "company").length ? habit.tools.filter((s) => s !== "company") : ["chatgpt"]);
    const prompt = taskPrompt(t.title);
    const helpful = rand() < 0.85 ? "yes" : "partly";
    const link = LINKS[li++ % LINKS.length];
    addConversation({ id: ulid(rand, startedAt), userId: p.userId, key: p.key, source, topic, prompt, startedAt, helpful, sensitive: [], taskId: t.id, taskLink: link });
    out.push(
      `INSERT INTO work.task_ai_assists (task_id, first_at, last_at, calls, tokens, people) VALUES ${row([t.id, new Date(startedAt), new Date(startedAt + 3600_000), 1 + Math.floor(rand() * 3), 0, [p.userId]])} ON CONFLICT (task_id) DO NOTHING;`,
    );
  }

  // Pending hints for the staff demo user: the task they had open when they asked, waiting for one tap.
  const staff = byKey.get(staffKey);
  if (staff) {
    openTasks
      .filter((t) => t.assignee === staffKey)
      .slice(0, 2)
      .forEach((t, i) => {
        const startedAt = now - (i + 1) * 5 * 3600_000;
        addConversation({
          id: ulid(rand, startedAt),
          userId: staff.userId,
          key: staffKey,
          source: "chatgpt",
          topic: "code",
          prompt: hintPrompt(t.title),
          startedAt,
          helpful: null,
          sensitive: [],
          hintTaskId: t.id,
        });
      });
  }

  // Sensitive data: the prompts that carried it, and the safety events (counts only, never text).
  SENSITIVE.forEach(([key, s], i) => {
    const p = byKey.get(key);
    if (!p || !HABITS[key]) return;
    const startedAt = now - (2 + i * 6) * DAY - 3 * 3600_000;
    addConversation({
      id: ulid(rand, startedAt),
      userId: p.userId,
      key,
      source: pick(HABITS[key].tools.filter((x) => x !== "company")),
      topic: s.topic,
      prompt: s.prompt,
      startedAt,
      helpful: "yes",
      sensitive: s.kinds,
    });
  });
  const safety = SAFETY_SPREAD.map(([key, action, kinds], i) => {
    const p = byKey.get(key);
    if (!p || !HABITS[key]) return null;
    const at = now - (1 + ((i * 4) % 50)) * DAY - Math.floor(rand() * 8) * 3600_000;
    return row([ulid(rand, at), p.userId, pick(HABITS[key].tools.filter((x) => x !== "company")), action, kinds, 1 + Math.floor(rand() * 2), new Date(at)]);
  }).filter(Boolean);

  // Company AI: the cost side. Calls follow the people who use the company's own AI, a few on tasks.
  for (const c of convs.filter((x) => x.source === "company")) {
    const p = byKey.get(c.key);
    const calls = 2 + Math.floor(rand() * 7);
    for (let i = 0; i < calls; i++) {
      let r = rand();
      const f = COMPANY_FEATURES.find(([, share]) => (r -= share) < 0) ?? COMPANY_FEATURES[0];
      const m = rand() < COMPANY_MODELS[0][4] ? COMPANY_MODELS[0] : COMPANY_MODELS[1];
      const at = new Date(c.startedAt + i * 120_000);
      const onTask = f[0].startsWith("task_") ? tasks.find((t) => t.assignee === c.key) : null;
      usage.push([
        ulid(rand, at.getTime()),
        p.userId,
        f[0],
        m[1],
        Math.round(f[2] * 4 * (0.6 + rand())),
        Math.round(f[3] * 3 * (0.6 + rand())),
        at,
        m[0],
        deptIds[p.dept] ?? null,
        onTask ? "task" : null,
        onTask?.id ?? null,
      ]);
    }
  }

  out.push(
    `INSERT INTO ai.ai_conversations (id, user_id, source, external_key, title, model, topic, summary, sensitive, messages, started_at, last_at, helpful, helpful_at, task_id, task_link, task_linked_at, hint_task_id, topic_by) VALUES\n${convs
      .map((c) =>
        row([
          c.id,
          c.userId,
          c.source,
          c.source === "company" ? null : `${new URL(SOURCE_URL[c.source]).pathname}demo-${c.id.slice(-10).toLowerCase()}`,
          c.prompt.slice(0, 80),
          c.source === "company" ? "gpt-4.1-mini" : "",
          c.topic,
          "",
          c.sensitive,
          c.messages,
          new Date(c.startedAt),
          new Date(c.lastAt),
          c.helpful,
          c.helpful ? new Date(c.lastAt + 60_000) : null,
          c.taskId ?? null,
          c.taskLink ?? null,
          c.taskId ? new Date(c.lastAt + 120_000) : null,
          c.hintTaskId ?? null,
          "keywords",
        ]),
      )
      .join(",\n")};`,
  );
  out.push(`INSERT INTO ai.ai_messages (id, conversation_id, role, content, at) VALUES\n${messages.map(row).join(",\n")};`);
  if (safety.length) out.push(`INSERT INTO ai.ai_safety_events (id, user_id, source, action, kinds, count, at) VALUES\n${safety.join(",\n")};`);
  if (usage.length)
    out.push(
      `INSERT INTO ai.ai_usage (id, user_id, feature, model, input_tokens, output_tokens, at, provider, department_id, subject_type, subject_id) VALUES\n${usage.map(row).join(",\n")};`,
    );
  const owner = people.find((p) => p.key === "owner");
  out.push(
    `INSERT INTO ai.ai_model_prices (provider, model, input_per_mtok, output_per_mtok, updated_by) VALUES ${COMPANY_MODELS.map(([prov, model, i, o]) => row([prov, model, i, o, owner.userId])).join(", ")} ON CONFLICT DO NOTHING;`,
  );
  // Everyone who used an outside AI has the extension connected (Admin › AI counts installs from these).
  out.push(`INSERT INTO ai.ai_monitor_tokens (user_id, token_hash, created_at, last_seen_at)
SELECT user_id, 'seed-' || md5(user_id), min(started_at), max(last_at) FROM ai.ai_conversations
 WHERE source <> 'company' GROUP BY 1
ON CONFLICT (user_id) DO UPDATE SET created_at = LEAST(ai.ai_monitor_tokens.created_at, EXCLUDED.created_at);`);
  // The hourly rollup the charts and the cost read (ai_hourly_stats), from the rows above, as the server keeps it.
  out.push(`INSERT INTO ai.ai_hourly_stats (hour, user_id, source, prompts)
SELECT date_trunc('hour', m.at), v.user_id, v.source, count(*) FROM ai.ai_messages m
  JOIN ai.ai_conversations v ON v.id = m.conversation_id
 WHERE m.role = 'user' GROUP BY 1, 2, 3
ON CONFLICT (hour, user_id, source, feature, provider, model) DO UPDATE SET prompts = EXCLUDED.prompts;`);
  out.push(`INSERT INTO ai.ai_hourly_stats (hour, user_id, source, feature, provider, model, calls, input_tokens, output_tokens)
SELECT date_trunc('hour', at), user_id, 'app', feature, coalesce(provider, ''), model, count(*), sum(input_tokens), sum(output_tokens) FROM ai.ai_usage
 GROUP BY 1, 2, 4, 5, 6
ON CONFLICT (hour, user_id, source, feature, provider, model) DO UPDATE
  SET calls = EXCLUDED.calls, input_tokens = EXCLUDED.input_tokens, output_tokens = EXCLUDED.output_tokens;`);
  // This month's running spend (budgets read it instead of summing ai_usage).
  out.push(`INSERT INTO ai.ai_spend_month (month, scope, scope_id, tokens, cost_usd)
SELECT date_trunc('month', at)::date, 'workspace', '', sum(input_tokens + output_tokens), sum(cost_usd) FROM ai.ai_usage_costed WHERE at >= date_trunc('month', now()) GROUP BY 1
UNION ALL SELECT date_trunc('month', at)::date, 'person', user_id, sum(input_tokens + output_tokens), sum(cost_usd) FROM ai.ai_usage_costed WHERE at >= date_trunc('month', now()) GROUP BY 1, user_id
UNION ALL SELECT date_trunc('month', at)::date, 'department', department_id, sum(input_tokens + output_tokens), sum(cost_usd) FROM ai.ai_usage_costed WHERE at >= date_trunc('month', now()) AND department_id IS NOT NULL GROUP BY 1, department_id
ON CONFLICT (month, scope, scope_id) DO UPDATE SET tokens = EXCLUDED.tokens, cost_usd = EXCLUDED.cost_usd;`);

  // Two full-text openings by the owner (each is shown to the person in Của tôi › AI) and one open erasure request.
  const viewed = ["minh", "trinh"].map((k) => convs.find((c) => c.key === k && c.source !== "company")).filter(Boolean);
  if (owner && viewed.length)
    out.push(
      `INSERT INTO ai.ai_content_views (id, viewer_id, user_id, conversation_id, at) VALUES ${viewed.map((c, i) => row([ulid(rand, now - (i + 3) * DAY), owner.userId, c.userId, c.id, new Date(now - (i + 3) * DAY)])).join(", ")};`,
    );
  const asks = byKey.get("anh");
  if (asks)
    out.push(
      `INSERT INTO ai.ai_erasure_requests (id, user_id, note, status, requested_at) VALUES ${row([ulid(rand, now - DAY), asks.userId, ERASURE_NOTE, "open", new Date(now - DAY)])};`,
    );
  // The safety net on "redact", with the company's own words, so the extension shows it working.
  out.push(
    `INSERT INTO ai.ai_policy (detail, capture_responses, retention_days, updated_by, sensitive_mode) VALUES ${row(["summary", false, 180, owner?.userId ?? null, "redact"])} ON CONFLICT (singleton) DO UPDATE SET sensitive_mode = 'redact';`,
  );
  if (owner) {
    out.push(
      `INSERT INTO ai.ai_keywords (id, term, label, created_by) VALUES ${COMPANY_KEYWORDS.map(([term, label]) => row([ulid(rand, now - 50 * DAY), term, label, owner.userId])).join(", ")} ON CONFLICT DO NOTHING;`,
    );
    out.push(
      `INSERT INTO ai.ai_topics (key, label_vi, label_en, keywords, builtin, archived, updated_by) VALUES ${COMPANY_TOPICS.map(([key, vi, en, kw]) => row([key, vi, en, kw, false, false, owner.userId])).join(", ")} ON CONFLICT DO NOTHING;`,
    );
  }
  // The prompt library: each shared from one of the author's own conversations, used across departments.
  const shared = LIBRARY.map(([key, topic, title, body, uses], i) => {
    const p = byKey.get(key);
    if (!p) return null;
    const from = convs.find((c) => c.key === key && c.source !== "company" && c.topic === topic) ?? convs.find((c) => c.key === key);
    const at = new Date(now - (6 + ((i * 3) % 45)) * DAY);
    return row([ulid(rand, at.getTime()), p.userId, from?.id ?? null, title, body, topic, uses, at]);
  }).filter(Boolean);
  if (shared.length) out.push(`INSERT INTO ai.ai_prompt_library (id, author_id, conversation_id, title, body, topic, uses, created_at) VALUES\n${shared.join(",\n")};`);
  // A few became the company's templates (the library's Công ty tab), one pinned; the rest stay personal, shared with all.
  out.push(`UPDATE ai.ai_prompt_library SET level = 'company', pinned = title = 'One-page PRD template' WHERE title IN (${COMPANY_PROMPTS.map(lit).join(", ")});`);

  const sql = ["BEGIN;", ...out, "COMMIT;"].join("\n");
  return {
    sql,
    counts: {
      conversations: convs.length,
      messages: messages.length,
      "safety events": safety.length,
      "company AI calls": usage.length,
      "AI-assisted tasks": assisted.size,
      "shared prompts": shared.length,
      "company topics": COMPANY_TOPICS.length,
      "company keywords": COMPANY_KEYWORDS.length,
    },
  };
}

/**
 * Runs the script as the database owner: through `pg` when the repository's dependencies are installed (development),
 * else through `psql` (the demo's seed container has the Postgres client but no node_modules).
 */
export async function runSql(sql, url, repoRoot) {
  let pg = null;
  try {
    pg = createRequire(join(repoRoot, "backend/server/package.json"))("pg");
  } catch {
    pg = null;
  }
  if (pg) {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      await client.query(sql);
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      await client.end();
    }
    return;
  }
  const r = spawnSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-q", "-f", "-"], { input: sql, encoding: "utf8" });
  if (r.error) throw new Error(`neither the pg package nor psql is available: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`psql: ${r.stderr.trim()}`);
}
