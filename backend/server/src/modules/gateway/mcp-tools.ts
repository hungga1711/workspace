import { z } from "zod";
import { featureDisabled, type DeployFeature, type Principal } from "@workspace/shared";
import {
  approvalDecisionBody,
  approvalRequestBody,
  calendarEventCreateBody,
  calendarRespondBody,
  docCreateBody,
  isoDateTime,
  messagePostBody,
  runStartBody,
  taskCommentBody,
  taskLinkBody,
  taskCreateBody,
  taskStatus,
  taskUpdateBody,
} from "@workspace/contracts";

/**
 * The MCP tools. Each one is a few calls to the public API, made by the gateway as the caller (`call` signs the
 * caller's principal exactly like a REST request), so every permission check and per-record rule of the modules
 * applies and nothing here reads a database. No tool needs an AI provider.
 */

export interface Upstream {
  status: number;
  body: unknown;
}
export type Call = (service: string, method: "GET" | "POST" | "PATCH" | "PUT", path: string, body?: unknown) => Promise<Upstream>;

export interface ToolContext {
  principal: Principal;
  /** Modules switched on for the workspace (`aiMonitoring` = AI Insights). */
  features: Record<string, boolean> | undefined;
  call: Call;
  /** The web app's public origin, for links back to what a tool returns (optional: links are left out without it). */
  appUrl?: string | undefined;
  /** Who called which tool and whether it worked (the activity log; never arguments or answers). */
  onToolCall?: ((tool: string, ok: boolean, error: string | null, durationMs: number) => void) | undefined;
}

export interface Tool<S extends z.AnyZodObject = z.AnyZodObject> {
  name: string;
  title: string;
  description: string;
  input: S;
  readOnly: boolean;
  /** Overwrites or removes something (MCP destructiveHint); only meaningful for a tool that writes. */
  destructive?: boolean;
  /** Calling it twice with the same arguments changes nothing more (MCP idempotentHint). */
  idempotent?: boolean;
  run(input: z.output<S>, ctx: ToolContext): Promise<unknown>;
}

/** An answer the agent should read as a refusal or failure (`isError` in MCP), with the module's reason. */
export class ToolError extends Error {
  constructor(
    message: string,
    readonly detail?: unknown,
    /** Short reason for the activity log: not_allowed, not_found, invalid, conflict, failed. */
    readonly code: string = "failed",
  ) {
    super(message);
  }
}

async function ok<T>(p: Promise<Upstream>): Promise<T> {
  const r = await p;
  if (r.status >= 400) {
    const b = r.body as { error?: unknown; message?: unknown } | null;
    const why = typeof b?.message === "string" ? b.message : typeof b?.error === "string" ? b.error : `HTTP ${r.status}`;
    const code = r.status === 403 || r.status === 401 ? "not_allowed" : r.status === 404 ? "not_found" : r.status === 409 ? "conflict" : r.status < 500 ? "invalid" : "failed";
    throw new ToolError(r.status === 403 ? `Not allowed: ${why}` : r.status === 404 ? `Not found: ${why}` : why, r.body, code);
  }
  return r.body as T;
}

const qs = (o: Record<string, string | number | undefined>) => {
  const e = Object.entries(o).filter(([, v]) => v !== undefined && v !== "");
  return e.length ? "?" + new URLSearchParams(e.map(([k, v]) => [k, String(v)])).toString() : "";
};

interface TaskDto {
  id: string;
  code: string;
  title: string;
  status: string;
  priority: string;
  dueAt: string | null;
  assigneeId: string | null;
  projectId: string | null;
  progress: number;
  atRisk: boolean;
  blockedReason: string | null;
  version: number;
}
/** What an agent needs of a task; the full record is one get away and costs it tokens. */
const brief = (t: TaskDto) => ({
  id: t.id,
  code: t.code,
  title: t.title,
  status: t.status,
  priority: t.priority,
  dueAt: t.dueAt,
  assigneeId: t.assigneeId,
  projectId: t.projectId,
  progress: t.progress,
  atRisk: t.atRisk,
  blockedReason: t.blockedReason,
  version: t.version,
});

interface ProjectDto {
  id: string;
  code: string;
  name: string;
  status: string;
  dueAt: string | null;
  openTasks: number;
  overdueTasks: number;
  blockedTasks: number;
  atRiskTasks: number;
  doneTasks: number;
  totalTasks: number;
  health: string;
  daysLeft: number | null;
}
const progressOf = (p: ProjectDto) => ({
  id: p.id,
  code: p.code,
  name: p.name,
  health: p.health,
  percentDone: p.totalTasks ? Math.round((100 * p.doneTasks) / p.totalTasks) : 0,
  doneTasks: p.doneTasks,
  totalTasks: p.totalTasks,
  openTasks: p.openTasks,
  overdueTasks: p.overdueTasks,
  blockedTasks: p.blockedTasks,
  atRiskTasks: p.atRiskTasks,
  dueAt: p.dueAt,
  daysLeft: p.daysLeft,
});

const tool = <S extends z.AnyZodObject>(t: Tool<S>): Tool => t as unknown as Tool;

/** A link of the integrations hub as the work module returns it (work/integrations/hub.ts linkDto). */
interface LinkDto {
  id: string;
  provider: string;
  providerName: string;
  url: string;
  kind: string;
  source: string;
  card: Record<string, unknown> | null;
  cardAt: string | null;
  error: string | null;
  connected: boolean;
}
/** What an agent needs of it: the card's facts, or why there is none. */
const linkOut = (l: LinkDto) => ({
  id: l.id,
  tool: l.providerName,
  kind: l.kind,
  url: l.url,
  ...(l.card ? { ...l.card, readAt: l.cardAt } : { unread: l.connected ? (l.error ?? "not read yet") : `${l.providerName} is not connected` }),
});

/** Record ids are ULIDs; anything else (WEB-42, T-041, D-012, #general) is a code or a name to look up first. */
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
const ref = (what: string) => z.string().trim().min(1).max(64).describe(`The ${what}'s id or its code as shown in the app`);

/** Display names by user id, read once per tool call (the directory, public fields only). */
const directory = new WeakMap<ToolContext, Promise<Map<string, string>>>();
function names(ctx: ToolContext): Promise<Map<string, string>> {
  let m = directory.get(ctx);
  if (!m) {
    m = ctx
      .call("employee", "GET", "/employees?all=1")
      .then((r) => new Map(r.status < 400 ? ((r.body as { employees?: { userId: string; displayName: string }[] }).employees ?? []).map((e) => [e.userId, e.displayName]) : []))
      .catch(() => new Map<string, string>());
    directory.set(ctx, m);
  }
  return m;
}
const nameOf = (n: Map<string, string>, id: string | null | undefined) => (id ? (n.get(id) ?? null) : null);

/** A link into the web app for what a tool returns, when the gateway knows the app's address. */
const link = (ctx: ToolContext, path: string) => (ctx.appUrl ? `${ctx.appUrl}${path}` : undefined);

/** A task's id and version from its id or code (one read, which also checks the caller may see it). */
async function taskRef(ctx: ToolContext, idOrCode: string): Promise<TaskDto> {
  return (await ok<{ task: TaskDto }>(ctx.call("work", "GET", `/tasks/${encodeURIComponent(idOrCode)}`))).task;
}

const needsPerson = (ctx: ToolContext, what: string) => {
  if (ctx.principal.type !== "user")
    throw new ToolError(`This API key is a workspace key, not a person: ${what} needs a personal key or an app connected over OAuth (Me › AI agents).`, undefined, "invalid");
};

interface ChannelDto {
  id: string;
  kind: string;
  name: string | null;
  displayName?: string | null;
  topic?: string | null;
  unread?: number;
  mentions?: number;
  dmUserId?: string | null;
  lastMessageAt?: string | null;
  memberCount?: number;
}
interface MessageDto {
  id: string;
  seq: number | string;
  authorId: string | null;
  authorType?: string;
  importAuthor?: string | null;
  body: string;
  replyCount?: number;
  createdAt: string;
  editedAt?: string | null;
  deletedAt?: string | null;
  attachments?: { name?: string }[];
}

/** A channel by id, name (`general`, `#general`) or display name, among those the caller is in or may join. */
async function channelRef(ctx: ToolContext, key: string) {
  const r = await ok<{ channels: ChannelDto[]; browsable: ChannelDto[] }>(ctx.call("chat", "GET", "/channels"));
  const k = key.replace(/^#/, "").toLowerCase();
  const all = [...r.channels.map((c) => ({ ...c, member: true })), ...r.browsable.map((c) => ({ ...c, member: false }))];
  const hit = all.find((c) => c.id === key) ?? all.find((c) => c.name?.toLowerCase() === k) ?? all.find((c) => c.displayName?.toLowerCase() === k);
  if (!hit) throw new ToolError(`No channel "${key}" that you can see. list_channels shows them.`, undefined, "not_found");
  return hit;
}

const messageOut = (n: Map<string, string>) => (m: MessageDto) => ({
  id: m.id,
  author: m.authorType === "agent" ? "AI" : (m.importAuthor ?? nameOf(n, m.authorId) ?? m.authorId),
  body: m.deletedAt ? "(deleted)" : m.body,
  at: m.createdAt,
  ...(m.replyCount ? { replies: m.replyCount } : {}),
  ...(m.editedAt ? { edited: true } : {}),
  ...(m.attachments?.length ? { files: m.attachments.map((a) => a.name ?? "file") } : {}),
});

interface WorkflowDto {
  id: string;
  name: string;
  description: string | null;
  category: string;
  runner: string;
  steps: { title: string; kind: string }[];
  config?: { environment?: { kind?: string }; inputs?: { key: string; label: string; type: string; required?: boolean; options?: string[] }[] };
}
interface RunDto {
  id: string;
  taskId: string;
  workflowName: string;
  status: string;
  currentStep: number;
  steps: { title: string; kind: string; state: string; output?: string; verdict?: { pass: boolean; issues: string[] }; startedAt?: string; finishedAt?: string }[];
  error: string | null;
  startedBy: string;
  createdAt: string;
  finishedAt: string | null;
  asks?: { id: string; stepIndex: number; questions: unknown; closedAt: string | null }[];
  canApprove?: boolean;
  canAnswer?: boolean;
  canControl?: boolean;
  doing?: { kind: string; tool: string | null; text: string };
}
/** A run as an agent needs it: where it is, each step in a line, what it waits for and what the caller may do. */
function runOut(ctx: ToolContext, r: RunDto, taskCode?: string, maxChars = 2000) {
  const open = r.asks?.find((a) => !a.closedAt);
  const waitsFor = r.status === "waiting_approval" ? "approval" : r.status === "waiting_input" ? "answers" : r.status === "queued" ? "a computer or the AI to take it" : null;
  return {
    id: r.id,
    taskId: r.taskId,
    workflow: r.workflowName,
    status: r.status,
    ...(r.error ? { error: r.error } : {}),
    step: r.steps[r.currentStep] ? `${r.currentStep + 1} of ${r.steps.length}: ${r.steps[r.currentStep]!.title}` : `${r.steps.length} of ${r.steps.length}`,
    ...(r.doing ? { doing: [r.doing.tool, r.doing.text].filter(Boolean).join(" ") } : {}),
    ...(waitsFor ? { waitsFor } : {}),
    ...(open ? { openQuestions: { id: open.id, questions: open.questions } } : {}),
    mayApprove: r.canApprove === true,
    mayAnswer: r.canAnswer === true && !!open,
    mayStop: r.canControl === true,
    steps: r.steps.map((s, index) => ({
      index,
      title: s.title,
      kind: s.kind,
      state: s.state,
      ...(s.verdict ? { check: s.verdict.pass ? "passed" : `failed: ${s.verdict.issues.join("; ")}`.slice(0, 600) } : {}),
      ...(s.output ? { result: s.output.slice(0, maxChars), ...(s.output.length > maxChars ? { truncated: true } : {}) } : {}),
    })),
    startedAt: r.createdAt,
    finishedAt: r.finishedAt,
    ...(taskCode ? { url: link(ctx, `/app/work/tasks/${taskCode}`) } : {}),
  };
}

interface ApprovalDto {
  id: string;
  code: string | null;
  title: string;
  details: string;
  requesterId: string;
  approverId: string;
  status: string;
  kind: string;
  amount: number | null;
  currency: string | null;
  fields?: Record<string, string>;
  createdAt: string;
  decidedAt: string | null;
}
const approvalOut = (ctx: ToolContext, n: Map<string, string>) => (a: ApprovalDto) => ({
  id: a.id,
  code: a.code,
  title: a.title,
  kind: a.kind,
  status: a.status,
  ...(a.amount !== null ? { amount: a.amount, currency: a.currency } : {}),
  requester: nameOf(n, a.requesterId) ?? a.requesterId,
  approver: nameOf(n, a.approverId) ?? a.approverId,
  askedAt: a.createdAt,
  decidedAt: a.decidedAt,
  url: link(ctx, `/app/work/approvals/${a.code ?? a.id}`),
});

interface EventDto {
  id: string;
  code: string | null;
  title: string;
  kind: string;
  startsAt: string;
  endsAt: string;
  organizerId: string;
  location: string;
  response?: string;
  recurrence?: string | null;
}
const eventOut = (ctx: ToolContext, n: Map<string, string>) => (e: EventDto) => ({
  id: e.id,
  code: e.code,
  title: e.title,
  kind: e.kind,
  startsAt: e.startsAt,
  endsAt: e.endsAt,
  ...(e.location ? { location: e.location } : {}),
  organizer: nameOf(n, e.organizerId) ?? e.organizerId,
  ...(e.response ? { myAnswer: e.response } : {}),
  ...(e.recurrence ? { repeats: e.recurrence } : {}),
  ...(e.kind === "meeting" ? { url: link(ctx, `/app/work/meetings/${e.code ?? e.id}`) } : {}),
});

export const TOOLS: Tool[] = [
  // ---------- tasks ----------
  tool({
    name: "list_my_tasks",
    title: "My tasks",
    description:
      "Tasks assigned to me plus my own unassigned to-dos, open first by due date (scope=owned: tasks I own). With projectId: that project's tasks I may read. Returns a page and nextCursor.",
    readOnly: true,
    input: z.object({
      status: taskStatus.optional(),
      scope: z.enum(["assigned", "owned"]).optional(),
      projectId: z.string().max(40).optional(),
      cursor: z.string().max(80).optional(),
    }),
    async run(i, ctx) {
      if (ctx.principal.type !== "user" && !i.projectId)
        throw new ToolError(
          "This API key is a workspace key, not a person: 'my tasks' needs a personal API key (Me › Profile › Sign-in and security › Personal API keys), or pass projectId.",
          undefined,
          "invalid",
        );
      const r = await ok<{ tasks: TaskDto[]; nextCursor: string | null }>(
        ctx.call("work", "GET", `/tasks${qs({ status: i.status, scope: i.scope === "owned" ? "owned" : undefined, projectId: i.projectId, cursor: i.cursor })}`),
      );
      return { tasks: r.tasks.map(brief), nextCursor: r.nextCursor };
    },
  }),
  tool({
    name: "get_task",
    title: "Read a task",
    description: "One task with its description, comments (newest 30), subtasks, dependencies and attached file names. Accepts the id or the code (WEB-42).",
    readOnly: true,
    input: z.object({ id: ref("task") }),
    async run(i, ctx) {
      const [r, n] = await Promise.all([
        ok<{
          task: TaskDto & { description: string; ownerId: string; labels: string[]; etaAt: string | null; completedAt: string | null };
          comments: { id: string; authorId: string; body: string; createdAt: string; editedAt: string | null }[];
          subtasks: TaskDto[];
          files: { name: string }[];
          dependencies: { waitingOn: { code: string; title: string; status: string }[]; blocking: { code: string; title: string; status: string }[] };
        }>(ctx.call("work", "GET", `/tasks/${encodeURIComponent(i.id)}`)),
        names(ctx),
      ]);
      const t = r.task;
      return {
        ...brief(t),
        description: t.description,
        labels: t.labels,
        owner: nameOf(n, t.ownerId),
        assignee: nameOf(n, t.assigneeId),
        expectedFinish: t.etaAt,
        completedAt: t.completedAt,
        url: link(ctx, `/app/work/tasks/${t.code}`),
        comments: (r.comments ?? [])
          .slice(-30)
          .map((c) => ({ id: c.id, author: nameOf(n, c.authorId) ?? c.authorId, body: c.body, at: c.createdAt, ...(c.editedAt ? { edited: true } : {}) })),
        subtasks: (r.subtasks ?? []).map(brief),
        waitingOn: r.dependencies?.waitingOn ?? [],
        blocking: r.dependencies?.blocking ?? [],
        files: (r.files ?? []).map((f) => f.name),
      };
    },
  }),
  tool({
    name: "create_task",
    title: "Create a task",
    description: "Create a task (in a project when projectId is given; otherwise a personal to-do). Dates are ISO 8601 with an offset.",
    readOnly: false,
    input: taskCreateBody.pick({ title: true, description: true, assigneeId: true, projectId: true, priority: true, dueAt: true, labels: true, parentId: true }),
    async run(i, ctx) {
      const t = await ok<TaskDto>(ctx.call("work", "POST", "/tasks", i));
      return { ...brief(t), url: link(ctx, `/app/work/tasks/${t.code}`) };
    },
  }),
  tool({
    name: "update_task",
    title: "Update a task",
    description:
      "Change a task's status, title, description, assignee, priority, due date, labels or blocked reason. Send only what changes. Accepts the id or the code. expectedVersion is optional: without it the current version is read first.",
    readOnly: false,
    destructive: true,
    idempotent: true,
    input: taskUpdateBody.omit({ customFields: true, recurrence: true }).extend({ id: ref("task"), expectedVersion: z.number().int().positive().optional() }),
    async run({ id, expectedVersion, ...changes }, ctx) {
      if (!Object.keys(changes).length) throw new ToolError("Nothing to change.", undefined, "invalid");
      const current = expectedVersion && ULID.test(id) ? null : await taskRef(ctx, id);
      const taskId = current?.id ?? id;
      return brief(await ok<TaskDto>(ctx.call("work", "PATCH", `/tasks/${encodeURIComponent(taskId)}`, { ...changes, expectedVersion: expectedVersion ?? current!.version })));
    },
  }),
  tool({
    name: "comment_on_task",
    title: "Comment on a task",
    description: "Add a comment to a task (Markdown; @mentions by name notify people as in the app). Accepts the id or the code.",
    readOnly: false,
    input: taskCommentBody.extend({ id: ref("task") }),
    async run(i, ctx) {
      const t = ULID.test(i.id) ? { id: i.id } : await taskRef(ctx, i.id);
      const c = await ok<{ id: string; createdAt?: string }>(ctx.call("work", "POST", `/tasks/${encodeURIComponent(t.id)}/comments`, { body: i.body }));
      return { ok: true, commentId: c.id, taskId: t.id };
    },
  }),

  // ---------- linked work (the integrations hub) ----------
  tool({
    name: "list_task_links",
    title: "A task's linked work",
    description:
      "Pull and merge requests, issues and designs linked to a task (id or code), as the company's connected tools report them now: title, state (open, draft, merged, closed), author, checks, reviewers, branch. May take a few seconds when a card is read again from its tool.",
    readOnly: true,
    input: z.object({ task: ref("task") }),
    async run(i, ctx) {
      const r = await ok<{ links: LinkDto[]; connected?: { id: string; name: string }[] }>(ctx.call("work", "GET", `/tasks/${encodeURIComponent(i.task)}/links`));
      return { links: r.links.map(linkOut), connectedTools: (r.connected ?? []).map((c) => c.name) };
    },
  }),
  tool({
    name: "link_work_to_task",
    title: "Link a pull request, issue or design to a task",
    description:
      "Attach the address of a pull or merge request, an issue or a design to a task (id or code). Only addresses an integration knows are accepted (GitHub, GitLab, Figma…); one whose tool is not connected yet is kept and says so.",
    readOnly: false,
    idempotent: true,
    input: taskLinkBody.extend({ task: ref("task") }),
    async run(i, ctx) {
      return linkOut(await ok<LinkDto>(ctx.call("work", "POST", `/tasks/${encodeURIComponent(i.task)}/links`, { url: i.url })));
    },
  }),
  tool({
    name: "project_reviews",
    title: "A project's pull and merge requests",
    description: "Every pull or merge request linked to the tasks of a project (id or code), open ones first, each with its task.",
    readOnly: true,
    input: z.object({ project: ref("project") }),
    async run(i, ctx) {
      const r = await ok<{ reviews: (LinkDto & { task: { code: string; title: string; status: string } })[] }>(
        ctx.call("work", "GET", `/projects/${encodeURIComponent(i.project)}/reviews`),
      );
      return { reviews: r.reviews.map((x) => ({ ...linkOut(x), task: x.task })) };
    },
  }),

  // ---------- agent workflows ----------
  tool({
    name: "list_workflows",
    title: "Agent workflows",
    description:
      "The workspace's agent workflows: what each does, its steps, the inputs a run asks for, and where it runs (assistant: the company's AI; sandbox or computer: a connected computer must be online). Use the id with start_workflow_run.",
    readOnly: true,
    input: z.object({ q: z.string().trim().max(100).optional().describe("Part of a name") }),
    async run(i, ctx) {
      const r = await ok<{ workflows: WorkflowDto[] }>(ctx.call("work", "GET", "/workflows"));
      const q = i.q?.toLowerCase();
      return {
        workflows: r.workflows
          .filter((w) => !q || w.name.toLowerCase().includes(q))
          .slice(0, 100)
          .map((w) => ({
            id: w.id,
            name: w.name,
            description: (w.description ?? "").slice(0, 400),
            category: w.category,
            runsOn: w.config?.environment?.kind ?? (w.runner === "local" ? "computer" : "assistant"),
            steps: w.steps.map((s) => ({ title: s.title, kind: s.kind })),
            inputs: (w.config?.inputs ?? []).map((f) => ({
              key: f.key,
              label: f.label,
              type: f.type,
              required: f.required === true,
              ...(f.options?.length ? { options: f.options } : {}),
            })),
          })),
      };
    },
  }),
  tool({
    name: "start_workflow_run",
    title: "Run a workflow on a task",
    description:
      "Hand a task to a workflow and start it (workflowId from list_workflows; omit it to run the workflow the task already has). inputs: the workflow's inputs by key. Returns the run; follow it with get_workflow_run. One run at a time per task.",
    readOnly: false,
    input: runStartBody.extend({ task: ref("task"), workflowId: z.string().max(40).optional() }),
    async run(i, ctx) {
      const t = await taskRef(ctx, i.task);
      if (i.workflowId) {
        const set = await ok<{ run: RunDto | null }>(ctx.call("work", "PUT", `/tasks/${encodeURIComponent(t.id)}/workflow`, { workflowId: i.workflowId }));
        // A workflow set to start by itself has started with the hand-over.
        if (set.run) return runOut(ctx, set.run, t.code);
      }
      return runOut(ctx, await ok<RunDto>(ctx.call("work", "POST", `/tasks/${encodeURIComponent(t.id)}/runs`, { ...(i.inputs ? { inputs: i.inputs } : {}) })), t.code);
    },
  }),
  tool({
    name: "get_workflow_run",
    title: "Read a workflow run",
    description:
      "A run by its id, or the latest run of a task (task id or code): status, each step's state and result, the questions it asked, what it waits for and whether I may approve or answer. step (index from 0) adds what the agent did in that step, a line per action; afterLine continues from the last line read.",
    readOnly: true,
    input: z.object({
      run: z.string().trim().max(64).optional().describe("The run's id"),
      task: z.string().trim().max(64).optional().describe("A task id or code: its latest run"),
      step: z.number().int().min(0).max(200).optional(),
      afterLine: z.number().int().min(0).optional(),
      maxChars: z.number().int().min(200).max(20_000).default(2000).describe("How much of each step's result to return"),
    }),
    async run(i, ctx) {
      if (!i.run && !i.task) throw new ToolError("Give run (a run id) or task (a task id or code).", undefined, "invalid");
      let r: RunDto;
      if (i.run) r = await ok<RunDto>(ctx.call("work", "GET", `/runs/${encodeURIComponent(i.run)}`));
      else {
        const list = await ok<{ runs: RunDto[] }>(ctx.call("work", "GET", `/tasks/${encodeURIComponent(i.task!)}/runs`));
        if (!list.runs[0]) throw new ToolError(`No run on "${i.task}" yet. start_workflow_run starts one.`, undefined, "not_found");
        r = list.runs[0];
      }
      const out = runOut(ctx, r, undefined, i.maxChars);
      if (i.step === undefined) return out;
      const a = await ok<{ events: { id: number; at: string; kind: string; tool: string | null; text: string; detail?: string }[]; more: boolean }>(
        ctx.call("work", "GET", `/runs/${encodeURIComponent(r.id)}/activity${qs({ step: i.step, after: i.afterLine })}`),
      );
      return { ...out, activity: { step: i.step, lines: a.events, lastLine: a.events.at(-1)?.id ?? i.afterLine ?? null, more: a.more } };
    },
  }),
  tool({
    name: "decide_workflow_run",
    title: "Approve, send back or answer a workflow run",
    description:
      "Act on a run that waits for a person. approve: let it past the approval it waits on (note goes to the next step). send_back: the AI redoes its result with my note. answer: answer the AI's open questions (answers by question id, from get_workflow_run), or skip=true to let it decide. Only when get_workflow_run says I may; do it when the person asked you to, their name goes on it.",
    readOnly: false,
    input: z.object({
      run: z.string().trim().min(1).max(64),
      action: z.enum(["approve", "send_back", "answer"]),
      note: z.string().max(4000).optional(),
      answers: z.record(z.string().max(40), z.string().max(4000)).optional(),
      skip: z.boolean().optional(),
    }),
    async run(i, ctx) {
      needsPerson(ctx, "deciding on a run");
      const id = encodeURIComponent(i.run);
      if (i.action === "approve") return runOut(ctx, await ok<RunDto>(ctx.call("work", "POST", `/runs/${id}/approve`, { note: i.note ?? "" })));
      if (i.action === "send_back") {
        if (!i.note?.trim()) throw new ToolError("Say what should change in note.", undefined, "invalid");
        return runOut(ctx, await ok<RunDto>(ctx.call("work", "POST", `/runs/${id}/rework`, { note: i.note })));
      }
      const r = await ok<RunDto>(ctx.call("work", "GET", `/runs/${id}`));
      const open = r.asks?.find((a) => !a.closedAt);
      if (!open) throw new ToolError("This run has no open questions.", undefined, "conflict");
      if (!i.skip && !Object.keys(i.answers ?? {}).length) throw new ToolError("Give answers (by question id) or skip=true.", undefined, "invalid");
      return runOut(ctx, await ok<RunDto>(ctx.call("work", "POST", `/agent-questions/${encodeURIComponent(open.id)}/answer`, i.skip ? { skip: true } : { answers: i.answers })));
    },
  }),
  tool({
    name: "stop_workflow_run",
    title: "Stop a workflow run",
    description: "Stop a run that is queued, running or waiting. What it already made stays on the run; nothing is delivered to the task.",
    readOnly: false,
    destructive: true,
    idempotent: true,
    input: z.object({ run: z.string().trim().min(1).max(64) }),
    async run(i, ctx) {
      const r = await ctx.call("work", "POST", `/runs/${encodeURIComponent(i.run)}/cancel`);
      // Already over: stopping it again changes nothing, which is what the caller wanted.
      if (r.status === 409) return runOut(ctx, await ok<RunDto>(ctx.call("work", "GET", `/runs/${encodeURIComponent(i.run)}`)));
      return runOut(ctx, await ok<RunDto>(Promise.resolve(r)));
    },
  }),

  // ---------- requests for approval ----------
  tool({
    name: "list_approvals",
    title: "Requests for approval",
    description: "Requests waiting for my decision (role=approver, the default) or the ones I sent (role=requester): newest first, pending ones unless status says otherwise.",
    readOnly: true,
    input: z.object({ role: z.enum(["approver", "requester"]).default("approver"), status: z.enum(["pending", "approved", "rejected", "cancelled", "all"]).default("pending") }),
    async run(i, ctx) {
      needsPerson(ctx, "approvals");
      const [r, n] = await Promise.all([ok<{ approvals: ApprovalDto[] }>(ctx.call("work", "GET", `/approvals${qs({ role: i.role })}`)), names(ctx)]);
      return { approvals: r.approvals.filter((a) => i.status === "all" || a.status === i.status).map(approvalOut(ctx, n)) };
    },
  }),
  tool({
    name: "get_approval",
    title: "Read a request for approval",
    description: "One request (id or code such as YC-007): what is asked, the amount, who asked and who decides, its discussion, and whether I may decide it.",
    readOnly: true,
    input: z.object({ id: ref("request") }),
    async run(i, ctx) {
      const [a, n] = await Promise.all([
        ok<ApprovalDto & { comment: string | null; canDecide: boolean; canCancel: boolean; events?: { actorId: string; kind: string; body: string | null; createdAt: string }[] }>(
          ctx.call("work", "GET", `/approvals/${encodeURIComponent(i.id)}`),
        ),
        names(ctx),
      ]);
      return {
        ...approvalOut(ctx, n)(a),
        details: a.details,
        fields: a.fields ?? {},
        decisionComment: a.comment,
        canDecide: a.canDecide,
        canCancel: a.canCancel,
        discussion: (a.events ?? []).slice(-30).map((e) => ({ who: nameOf(n, e.actorId) ?? e.actorId, what: e.kind, text: e.body, at: e.createdAt })),
      };
    },
  }),
  tool({
    name: "request_approval",
    title: "Send a request for approval",
    description: "Send a request to someone for approval (approverId from find_people). Money requests (purchase, payment, advance) need an amount.",
    readOnly: false,
    input: approvalRequestBody.omit({ templateId: true }),
    async run(i, ctx) {
      needsPerson(ctx, "a request for approval");
      const a = await ok<{ id: string; code?: string }>(ctx.call("work", "POST", "/approvals", i));
      return { ok: true, id: a.id, code: a.code, url: link(ctx, `/app/work/approvals/${a.code ?? a.id}`) };
    },
  }),
  tool({
    name: "decide_approval",
    title: "Approve or reject a request",
    description: "Decide a request that waits for me (id or code). Do it when the person told you their decision; it is recorded under their name and the requester is told.",
    readOnly: false,
    destructive: true,
    input: approvalDecisionBody.extend({ id: ref("request") }),
    async run({ id, ...body }, ctx) {
      needsPerson(ctx, "deciding a request");
      const a = ULID.test(id) ? { id } : await ok<{ id: string }>(ctx.call("work", "GET", `/approvals/${encodeURIComponent(id)}`));
      await ok(ctx.call("work", "POST", `/approvals/${encodeURIComponent(a.id)}/decision`, body));
      return { ok: true, id: a.id, decision: body.decision };
    },
  }),

  // ---------- calendar and meetings ----------
  tool({
    name: "list_calendar_events",
    title: "My calendar",
    description: "My meetings, deadlines and events between two moments (ISO 8601 with an offset; at most 62 days), with my answer to each invitation.",
    readOnly: true,
    input: z.object({ from: isoDateTime, to: isoDateTime }),
    async run(i, ctx) {
      needsPerson(ctx, "a calendar");
      if (Date.parse(i.to) - Date.parse(i.from) > 62 * 86_400_000) throw new ToolError("Ask for at most 62 days at a time.", undefined, "invalid");
      const [r, n] = await Promise.all([ok<{ events: EventDto[] }>(ctx.call("work", "GET", `/calendar/events${qs({ from: i.from, to: i.to })}`)), names(ctx)]);
      return { events: r.events.map(eventOut(ctx, n)) };
    },
  }),
  tool({
    name: "schedule_event",
    title: "Schedule a meeting or event",
    description:
      "Put a meeting, a deadline or an event on the calendar and invite people (attendeeIds from find_people); they are notified as in the app. Times are ISO 8601 with an offset.",
    readOnly: false,
    input: calendarEventCreateBody.omit({ recurrence: true }),
    async run(i, ctx) {
      needsPerson(ctx, "scheduling");
      const e = await ok<{ id: string; code?: string | null }>(ctx.call("work", "POST", "/calendar/events", i));
      return { ok: true, id: e.id, code: e.code ?? null, url: i.kind === "meeting" ? link(ctx, `/app/work/meetings/${e.code ?? e.id}`) : undefined };
    },
  }),
  tool({
    name: "respond_to_event",
    title: "Accept or decline an invitation",
    description: "Answer an invitation on my calendar (event id from list_calendar_events).",
    readOnly: false,
    idempotent: true,
    input: calendarRespondBody.extend({ id: z.string().trim().min(1).max(40) }),
    async run({ id, ...body }, ctx) {
      needsPerson(ctx, "answering an invitation");
      await ok(ctx.call("work", "POST", `/calendar/events/${encodeURIComponent(id)}/respond`, body));
      return { ok: true, id, response: body.response };
    },
  }),
  tool({
    name: "get_meeting",
    title: "Read a meeting",
    description: "A meeting I am invited to (id or code such as H-012): when and where, who answered what, its agenda, its minutes and the tasks made from it.",
    readOnly: true,
    input: z.object({ id: ref("meeting") }),
    async run(i, ctx) {
      const [m, n] = await Promise.all([
        ok<{
          event: EventDto & { agenda: string; notes: string; projectId: string | null; version: number };
          attendees: { userId: string; response: string }[];
          tasks?: TaskDto[];
        }>(ctx.call("work", "GET", `/meetings/${encodeURIComponent(i.id)}`)),
        names(ctx),
      ]);
      return {
        ...eventOut(ctx, n)(m.event),
        agenda: m.event.agenda,
        minutes: m.event.notes,
        attendees: (m.attendees ?? []).map((a) => ({ name: nameOf(n, a.userId) ?? a.userId, response: a.response })),
        actionItems: (m.tasks ?? []).map(brief),
      };
    },
  }),

  // ---------- projects ----------
  tool({
    name: "list_projects",
    title: "Projects",
    description: "Projects I may see with progress and health (active by default; status=archived for finished ones).",
    readOnly: true,
    input: z.object({ status: z.enum(["active", "archived"]).optional() }),
    async run(i, ctx) {
      const r = await ok<{ projects: (ProjectDto & { status: string })[] }>(ctx.call("work", "GET", `/projects${qs({ limit: 200, status: i.status })}`));
      return { projects: r.projects.map((p) => ({ ...progressOf(p), status: p.status })) };
    },
  }),
  tool({
    name: "get_project",
    title: "Read a project",
    description: "One project (id or code, e.g. WEB): description, owner, due date, recent history and its open tasks.",
    readOnly: true,
    input: z.object({ project: ref("project") }),
    async run(i, ctx) {
      const [p, n] = await Promise.all([
        ok<{
          id: string;
          code: string;
          name: string;
          description: string;
          ownerId: string;
          status: string;
          dueAt: string | null;
          history: { actor: string; action: string; at: string }[];
        }>(ctx.call("work", "GET", `/projects/${encodeURIComponent(i.project)}`)),
        names(ctx),
      ]);
      const tasks = await ok<{ tasks: TaskDto[] }>(ctx.call("work", "GET", `/tasks${qs({ projectId: p.id })}`));
      const open = tasks.tasks.filter((t) => t.status !== "done" && t.status !== "cancelled");
      return {
        id: p.id,
        code: p.code,
        name: p.name,
        description: p.description,
        owner: nameOf(n, p.ownerId),
        status: p.status,
        dueAt: p.dueAt,
        url: link(ctx, `/app/work/projects/${p.code}`),
        recent: p.history.slice(0, 10).map((h) => ({ who: nameOf(n, h.actor) ?? h.actor, what: h.action, at: h.at })),
        openTasks: open.slice(0, 50).map((t) => ({ ...brief(t), assignee: nameOf(n, t.assigneeId) })),
        moreOpenTasks: Math.max(0, open.length - 50),
      };
    },
  }),
  tool({
    name: "project_progress",
    title: "Project progress",
    description: "Progress and health of one project (projectId or its code, e.g. WEB) or of every active project: percent done, overdue, blocked and at-risk tasks, days left.",
    readOnly: true,
    input: z.object({ project: z.string().max(40).optional().describe("Project id or code; omit for all active projects") }),
    async run(i, ctx) {
      const r = await ok<{ projects: ProjectDto[] }>(ctx.call("work", "GET", "/projects?limit=200"));
      if (!i.project) return { projects: r.projects.map(progressOf) };
      const key = i.project.toUpperCase();
      const p = r.projects.find((x) => x.id === i.project || x.code.toUpperCase() === key);
      if (!p) throw new ToolError(`No active project "${i.project}" that you can see.`, undefined, "not_found");
      return progressOf(p);
    },
  }),

  // ---------- my day ----------
  tool({
    name: "my_day",
    title: "My day",
    description:
      "What needs me today: approvals, decisions, blockers, mentions and tasks waiting for me, today's meetings and deadlines, my open tasks by due date with this week's numbers, and unread inbox items.",
    readOnly: true,
    input: z.object({}),
    async run(_i, ctx) {
      needsPerson(ctx, "my_day");
      const [home, summary, inbox] = await Promise.all([ctx.call("home", "GET", "/home"), ctx.call("work", "GET", "/me/summary"), ctx.call("home", "GET", "/notifications")]);
      // Each part is optional: a key without home.read still gets its tasks, and the other way round.
      const h = home.status < 400 ? (home.body as { counts: unknown; needsYou: unknown[]; today: unknown[]; timezone: string }) : null;
      const s = summary.status < 400 ? (summary.body as { open: TaskDto[]; stats: unknown }) : null;
      const n = inbox.status < 400 ? (inbox.body as { action: { title: string; body: string; url: string; readAt: string | null; createdAt: string }[] }) : null;
      if (!h && !s && !n) throw new ToolError("Not allowed: this connection cannot read your home, tasks or inbox.", undefined, "not_allowed");
      return {
        ...(h ? { timezone: h.timezone, counts: h.counts, needsYou: h.needsYou, today: h.today } : {}),
        ...(s ? { myOpenTasks: s.open.slice(0, 20).map(brief), moreOpenTasks: Math.max(0, s.open.length - 20), week: s.stats } : {}),
        ...(n
          ? {
              unreadInbox: n.action
                .filter((x) => !x.readAt)
                .slice(0, 15)
                .map((x) => ({ title: x.title, body: x.body, url: x.url, at: x.createdAt })),
            }
          : {}),
      };
    },
  }),

  // ---------- documents and whiteboards ----------
  tool({
    name: "list_documents",
    title: "Documents",
    description: "Documents I may read, most recently updated first (up to 50). q filters by title; label by label. For full-text search use `search` with types=[document].",
    readOnly: true,
    input: z.object({ q: z.string().trim().max(200).optional(), label: z.string().max(40).optional() }),
    async run(i, ctx) {
      const r = await ok<{ documents: { id: string; code: string; title: string; visibility: string; updatedAt: string; ownerId: string }[] }>(
        ctx.call("work", "GET", `/docs${qs({ label: i.label })}`),
      );
      const q = i.q?.toLowerCase();
      const docs = r.documents.filter((d) => !q || d.title.toLowerCase().includes(q)).slice(0, 50);
      return { documents: docs.map((d) => ({ id: d.id, code: d.code, title: d.title, visibility: d.visibility, updatedAt: d.updatedAt })) };
    },
  }),
  tool({
    name: "read_document",
    title: "Read a document",
    description: "A document's text (Markdown when it was written in Markdown, otherwise plain text), up to maxChars characters. Accepts the id or the code (D-012).",
    readOnly: true,
    input: z.object({ id: ref("document"), maxChars: z.number().int().min(500).max(200_000).default(30_000) }),
    async run(i, ctx) {
      // track=0: an agent reading for someone is not a page view.
      const r = await ok<{ document: { id: string; code: string; title: string; visibility: string; version: number }; content: string; format: string; text: string }>(
        ctx.call("work", "GET", `/docs/${encodeURIComponent(i.id)}?track=0`),
      );
      const body = r.format === "markdown" ? r.content : r.text;
      const d = r.document;
      return {
        id: d.id,
        code: d.code,
        title: d.title,
        visibility: d.visibility,
        version: d.version,
        format: r.format === "markdown" ? "markdown" : "text",
        url: link(ctx, `/app/work/docs/${r.document.code}`),
        content: body.slice(0, i.maxChars),
        truncated: body.length > i.maxChars,
        length: body.length,
      };
    },
  }),
  tool({
    name: "create_document",
    title: "Create a document",
    description:
      "Create a document page from Markdown. Private to me unless visibility says otherwise (workspace: everyone; project: the project's people; or spaceId to file it in a space).",
    readOnly: false,
    input: docCreateBody.pick({ title: true, content: true, projectId: true, visibility: true, spaceId: true, parentId: true, labels: true }),
    async run(i, ctx) {
      const d = await ok<{ id: string; code: string; title: string; visibility: string }>(ctx.call("work", "POST", "/docs", { ...i, format: "markdown" }));
      return { id: d.id, code: d.code, title: d.title, visibility: d.visibility, url: link(ctx, `/app/work/docs/${d.code}`) };
    },
  }),
  tool({
    name: "list_whiteboards",
    title: "Whiteboards",
    description: "Whiteboards I may open (q filters by title; projectId for one project's boards).",
    readOnly: true,
    input: z.object({ q: z.string().trim().max(200).optional(), projectId: z.string().max(40).optional() }),
    async run(i, ctx) {
      const r = await ok<{ whiteboards: { id: string; code: string; title: string; projectName: string | null; updatedAt: string }[] }>(
        ctx.call("work", "GET", `/whiteboards${qs({ q: i.q, scope: i.projectId ? "project" : undefined, projectId: i.projectId })}`),
      );
      return { whiteboards: r.whiteboards.slice(0, 100).map((b) => ({ id: b.id, code: b.code, title: b.title, project: b.projectName, updatedAt: b.updatedAt })) };
    },
  }),
  tool({
    name: "read_whiteboard",
    title: "Read a whiteboard",
    description: "The words on a whiteboard: sticky notes, labels and free text. Accepts the id or the code (W-003).",
    readOnly: true,
    input: z.object({ id: ref("whiteboard") }),
    async run(i, ctx) {
      const r = await ok<{ id: string; code: string; title: string; stickies: string[]; labels: string[]; text: string }>(
        ctx.call("work", "GET", `/whiteboards/${encodeURIComponent(i.id)}/text`),
      );
      return { ...r, url: link(ctx, `/app/work/whiteboards/${r.code}`) };
    },
  }),

  // ---------- chat ----------
  tool({
    name: "list_channels",
    title: "Chat channels",
    description: "My channels and direct messages with unread counts, and public channels I could join.",
    readOnly: true,
    input: z.object({}),
    async run(_i, ctx) {
      const [r, n] = await Promise.all([ok<{ channels: ChannelDto[]; browsable: ChannelDto[] }>(ctx.call("chat", "GET", "/channels")), names(ctx)]);
      return {
        channels: r.channels.map((c) => ({
          id: c.id,
          kind: c.kind,
          name: c.kind === "dm" ? (nameOf(n, c.dmUserId) ?? c.displayName ?? "DM") : (c.displayName ?? c.name),
          ...(c.topic ? { topic: c.topic } : {}),
          unread: c.unread ?? 0,
          mentions: c.mentions ?? 0,
          lastMessageAt: c.lastMessageAt ?? null,
        })),
        canJoin: r.browsable.map((c) => ({ id: c.id, name: c.displayName ?? c.name, members: c.memberCount ?? 0 })),
      };
    },
  }),
  tool({
    name: "read_channel",
    title: "Read a channel",
    description:
      "Recent messages in a channel or DM I can read (channel id or name such as general), oldest to newest. limit up to 100; before = the previous answer's nextBefore for older ones. Thread replies: read_thread.",
    readOnly: true,
    input: z.object({
      channel: z.string().trim().min(1).max(100),
      limit: z.number().int().min(1).max(100).default(30),
      before: z.union([z.number(), z.string().max(20)]).optional(),
    }),
    async run(i, ctx) {
      const [c, n] = await Promise.all([channelRef(ctx, i.channel), names(ctx)]);
      const r = await ok<{ messages: MessageDto[]; nextBefore: number | string | null }>(
        ctx.call("chat", "GET", `/channels/${encodeURIComponent(c.id)}/messages${qs({ limit: i.limit, before: i.before === undefined ? undefined : String(i.before) })}`),
      );
      return { channel: { id: c.id, name: c.displayName ?? c.name }, messages: [...r.messages].reverse().map(messageOut(n)), nextBefore: r.nextBefore };
    },
  }),
  tool({
    name: "read_thread",
    title: "Read a thread",
    description: "A message's thread: the first message and its replies.",
    readOnly: true,
    input: z.object({ messageId: z.string().trim().min(1).max(40) }),
    async run(i, ctx) {
      const [r, n] = await Promise.all([
        ok<{ root: MessageDto; replies: MessageDto[] }>(ctx.call("chat", "GET", `/messages/${encodeURIComponent(i.messageId)}/thread`)),
        names(ctx),
      ]);
      return { root: messageOut(n)(r.root), replies: r.replies.map(messageOut(n)) };
    },
  }),
  tool({
    name: "post_message",
    title: "Post a chat message",
    description:
      "Post a message as me in a channel I belong to (channel id or name), or reply in a thread with threadRootId. Markdown. Use it when the person asked you to post; people read it as theirs.",
    readOnly: false,
    // Agents often call the message "text": accepted as the same field, so the call does not fail on a name.
    input: messagePostBody
      .pick({ threadRootId: true })
      .extend({ channel: z.string().trim().min(1).max(100), body: messagePostBody.shape.body.optional(), text: messagePostBody.shape.body.optional() }),
    async run(i, ctx) {
      const body = i.body ?? i.text;
      if (!body) throw new ToolError("Write the message in body.", undefined, "invalid");
      const c = await channelRef(ctx, i.channel);
      if (!c.member) throw new ToolError(`You are not in #${c.name}: join it in the app first.`, undefined, "not_allowed");
      const m = await ok<MessageDto>(ctx.call("chat", "POST", `/channels/${encodeURIComponent(c.id)}/messages`, { body, threadRootId: i.threadRootId ?? null }));
      return { ok: true, messageId: m.id, channel: c.displayName ?? c.name, at: m.createdAt };
    },
  }),

  // ---------- people, search, team ----------
  tool({
    name: "find_people",
    title: "Find people",
    description:
      "The company directory: name, title, department and manager. q = part of a name; userId = one person. Use it to turn ids from other tools into names, or names into assigneeIds.",
    readOnly: true,
    input: z.object({ q: z.string().trim().max(100).optional(), userId: z.string().max(40).optional() }),
    async run(i, ctx) {
      if (i.userId) return ok(ctx.call("employee", "GET", `/employees/${encodeURIComponent(i.userId)}`));
      const r = await ok<{
        employees: { userId: string; displayName: string; title: string | null; department: string | null; managerId: string | null }[];
        nextCursor: string | null;
      }>(ctx.call("employee", "GET", `/employees${qs({ q: i.q, limit: 50 })}`));
      return { people: r.employees, more: r.nextCursor !== null };
    },
  }),
  tool({
    name: "search",
    title: "Search the workspace",
    description: "Full-text search over messages, channels, files, people, tasks, projects and documents I may read.",
    readOnly: true,
    input: z.object({
      q: z.string().trim().min(2).max(200),
      types: z
        .array(z.enum(["message", "channel", "file", "person", "task", "project", "document"]))
        .max(7)
        .optional(),
    }),
    async run(i, ctx) {
      const r = await ok<{ hits: { entity_type: string; entity_id: string; container_id?: string; title: string; body?: string; url?: string; updated_at?: string }[] }>(
        ctx.call("chat", "GET", `/search${qs({ q: i.q, types: i.types?.join(",") })}`),
      );
      // What an agent needs to pick a hit and open it with another tool; the index's own fields stay out.
      return {
        hits: r.hits.map((h) => ({
          type: h.entity_type,
          id: h.entity_id,
          title: h.title,
          ...(h.body ? { snippet: h.body.slice(0, 300) } : {}),
          ...(h.entity_type === "message" && h.container_id ? { channelId: h.container_id } : {}),
          ...(h.url ? { url: link(ctx, h.url) ?? h.url } : {}),
          updatedAt: h.updated_at,
        })),
      };
    },
  }),
  tool({
    name: "team_workload",
    title: "Team workload",
    description: "Open, overdue, at-risk and blocked work per person and department for the people I manage (admins: everyone), with the tasks worth asking about.",
    readOnly: true,
    input: z.object({}),
    async run(_i, ctx) {
      return ok(ctx.call("work", "GET", "/followup/team?brief=1"));
    },
  }),
  tool({
    name: "overdue_work",
    title: "Overdue and at-risk work",
    description: "Tasks past their due date or at risk of missing it, among the tasks I may read, optionally for one project (code or id).",
    readOnly: true,
    input: z.object({ project: z.string().max(80).optional() }),
    async run(i, ctx) {
      return ok(ctx.call("work", "GET", `/task-tools/late${i.project ? `?project=${encodeURIComponent(i.project)}` : ""}`));
    },
  }),
  tool({
    name: "blocked_work",
    title: "Blocked work",
    description: "Blocked tasks I may read, longest blocked first, with the chain of open tasks each one waits on and how many tasks wait on it.",
    readOnly: true,
    input: z.object({}),
    async run(_i, ctx) {
      return ok(ctx.call("work", "GET", "/reports/blockers"));
    },
  }),
  tool({
    name: "team_output",
    title: "Team output",
    description: "Tasks finished per person I manage (admins: everyone) over 7, 14, 30 or 90 days, next to the window before, with the on-time rate.",
    readOnly: true,
    input: z.object({ days: z.union([z.literal(7), z.literal(14), z.literal(30), z.literal(90)]).default(30) }),
    async run(i, ctx) {
      return ok(ctx.call("work", "GET", `/reports/output?days=${i.days}`));
    },
  }),
  tool({
    name: "unanswered_questions",
    title: "Unanswered questions",
    description: "Questions put to me in chat (mentions, direct and group conversations) that nobody has answered after `hours`, looking back `days`.",
    readOnly: true,
    input: z.object({ hours: z.number().int().min(0).max(720).default(4), days: z.number().int().min(1).max(60).default(14) }),
    async run(i, ctx) {
      return ok(ctx.call("chat", "GET", `/assist/unanswered?hours=${i.hours}&days=${i.days}`));
    },
  }),
  tool({
    name: "attendance_summary",
    title: "Attendance summary",
    description: "Days worked, hours, late arrivals, missed clock-outs, leave and absences per person I may see, for a period of up to 92 days (default: this month).",
    readOnly: true,
    input: z.object({
      from: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
      to: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
      department: z.string().max(120).optional(),
    }),
    async run(i, ctx) {
      const q = new URLSearchParams(Object.entries(i).filter((e): e is [string, string] => typeof e[1] === "string" && !!e[1]));
      return ok(ctx.call("employee", "GET", `/attendance/summary${q.size ? `?${q}` : ""}`));
    },
  }),
  tool({
    name: "ai_insights_summary",
    title: "AI Insights summary",
    description:
      "How the people I may see use AI at work over 7, 30 or 90 days: by department, tool and topic, sensitive-data warnings, cost of the company AI, and tasks finished with AI help vs without. Aggregates only, never conversation text.",
    readOnly: true,
    input: z.object({ days: z.union([z.literal(7), z.literal(30), z.literal(90)]).default(30) }),
    async run(i, ctx) {
      // The company has not switched AI Insights on: say so instead of an opaque 404.
      if (ctx.features?.aiMonitoring !== true) return { enabled: false, message: "AI Insights is switched off for this workspace (Admin › AI)." };
      const [ai, work] = await Promise.all([ok<Oversight>(ctx.call("ai", "GET", `/oversight?days=${i.days}`)), ctx.call("work", "GET", `/followup/outcomes?days=${i.days}`)]);
      return summarizeInsights(ai, i.days, work.status < 400 ? (work.body as { withAi?: unknown }).withAi : undefined);
    },
  }),
];

interface Oversight {
  policy?: { detail?: string };
  totals: Record<string, number>;
  departments: {
    name: string | null;
    people: number;
    active: number;
    prompts: number;
    inApp: number;
    flagged: number;
    cost: number;
    sources: Record<string, number>;
    topics: Record<string, number>;
  }[];
  features?: { feature: string; calls: number }[];
}

/** Department, tool and topic counts from Công việc › AI; the per-person rows stay in the app. */
export function summarizeInsights(o: Oversight, days: number, withAi?: unknown) {
  const add = (into: Record<string, number>, from: Record<string, number>) => {
    for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v;
  };
  const tools: Record<string, number> = {};
  const topics: Record<string, number> = {};
  for (const d of o.departments) {
    add(tools, d.sources ?? {});
    add(topics, d.topics ?? {});
  }
  const sorted = (r: Record<string, number>) => Object.fromEntries(Object.entries(r).sort((a, b) => b[1] - a[1]));
  return {
    enabled: true,
    days,
    totals: o.totals,
    tools: sorted(tools),
    topics: sorted(topics),
    departments: o.departments.map((d) => ({
      name: d.name ?? "(no department)",
      people: d.people,
      activePeople: d.active,
      prompts: d.prompts,
      companyAiCalls: d.inApp,
      sensitiveFlags: d.flagged,
      costUsd: Math.round(d.cost * 100) / 100,
      topTopics: Object.keys(sorted(d.topics ?? {})).slice(0, 3),
    })),
    companyAiFeatures: (o.features ?? []).slice(0, 10).map((f) => ({ feature: f.feature, calls: f.calls })),
    ...(withAi ? { tasksWithAi: withAi } : {}),
  };
}

const text = (t: string) => [{ type: "text" as const, text: t }];

/**
 * The permission each tool cannot work without (any scope). A key or agent without it does not see the tool in
 * tools/list, and a call is refused up front with the reason; per-record rules still apply inside the modules.
 * Tools that filter what they return for anyone (search, AI Insights) need nothing here.
 */
export const TOOL_NEEDS: Record<string, string[]> = {
  list_my_tasks: ["task.read"],
  get_task: ["task.read"],
  create_task: ["task.create"],
  update_task: ["task.edit"],
  comment_on_task: ["task.read"],
  list_task_links: ["task.read"],
  // The module asks only task.read to link; a read-only connection must not change a task, so this asks for a write.
  link_work_to_task: ["task.edit"],
  project_reviews: ["project.read"],
  list_workflows: ["task.read"],
  start_workflow_run: ["task.edit"],
  get_workflow_run: ["task.read"],
  // The module lets whoever started a run, or the approver a step names, act on it whatever they hold; a connection
  // approved as "read only" must still never decide, stop or answer anything, so these ask for a write permission.
  decide_workflow_run: ["task.edit"],
  stop_workflow_run: ["task.edit"],
  request_approval: ["task.create"],
  // Requests are sent with task.create (work/approvals.ts); deciding one is the same area's write.
  decide_approval: ["task.create"],
  list_calendar_events: ["calendar.read"],
  schedule_event: ["calendar.edit"],
  respond_to_event: ["calendar.edit"],
  get_meeting: ["calendar.read"],
  my_day: ["task.read"],
  team_workload: ["task.read"],
  list_projects: ["project.read"],
  get_project: ["project.read"],
  project_progress: ["project.read"],
  list_documents: ["document.read"],
  read_document: ["document.read"],
  create_document: ["document.create"],
  list_whiteboards: ["document.read"],
  read_whiteboard: ["document.read"],
  list_channels: ["channel.read"],
  read_channel: ["message.read"],
  read_thread: ["message.read"],
  post_message: ["message.post"],
  find_people: ["employee.profile.read"],
  overdue_work: ["task.read"],
  blocked_work: ["task.read"],
  team_output: ["task.read"],
  unanswered_questions: ["message.read"],
};

/** Tools of a feature a deployment can leave out (DISABLED_FEATURES): not listed and not callable without it. */
export const TOOL_FEATURE: Record<string, DeployFeature> = {
  list_documents: "docs",
  read_document: "docs",
  create_document: "docs",
  list_whiteboards: "whiteboards",
  read_whiteboard: "whiteboards",
  ai_insights_summary: "ai",
  list_workflows: "ai",
  start_workflow_run: "ai",
  get_workflow_run: "ai",
  decide_workflow_run: "ai",
  stop_workflow_run: "ai",
  list_calendar_events: "calendar",
  schedule_event: "calendar",
  respond_to_event: "calendar",
  get_meeting: "calendar",
  attendance_summary: "time",
};
const leftOut = (name: string) => {
  const feature = TOOL_FEATURE[name];
  return feature !== undefined && featureDisabled(feature);
};

/** Permissions a tool needs that the principal holds at no scope at all. */
export function missingFor(name: string, principal: Principal): string[] {
  return (TOOL_NEEDS[name] ?? []).filter((perm) => !principal.grants.some((g) => g.permission === perm));
}

/** The tools this principal can use (what tools/list shows them). */
export function toolsFor<T extends { name: string }>(tools: T[], principal: Principal): T[] {
  return tools.filter((t) => !leftOut(t.name) && !missingFor(t.name, principal).length);
}

/**
 * Runs one tool call; failures come back as a tool result with `isError`, which agents read and recover from. Every
 * call is reported to `ctx.onToolCall` (tool, ok, short reason, duration) for the activity log.
 */
export async function callTool(name: string, args: unknown, ctx: ToolContext) {
  const started = Date.now();
  const report = (ok: boolean, error: string | null) => ctx.onToolCall?.(name.slice(0, 80), ok, error, Date.now() - started);
  const t = leftOut(name) ? undefined : TOOLS.find((x) => x.name === name);
  if (!t) {
    report(false, "unknown_tool");
    return { isError: true, content: text(`Unknown tool: ${name}`) };
  }
  const missing = missingFor(name, ctx.principal);
  if (missing.length) {
    report(false, "not_allowed");
    return { isError: true, content: text(`Not allowed: this key or agent lacks ${missing.join(", ")}.`) };
  }
  const parsed = t.input.safeParse(args ?? {});
  if (!parsed.success) {
    report(false, "invalid_arguments");
    return { isError: true, content: text(`Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`) };
  }
  try {
    const out = await t.run(parsed.data, ctx);
    report(true, null);
    return { content: text(JSON.stringify(out)) };
  } catch (e) {
    if (e instanceof ToolError) {
      report(false, e.code);
      return { isError: true, content: text(e.message + (e.detail ? `\n${JSON.stringify(e.detail)}` : "")) };
    }
    report(false, "internal");
    throw e;
  }
}
