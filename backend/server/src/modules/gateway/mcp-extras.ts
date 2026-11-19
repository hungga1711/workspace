import { callTool, type ToolContext } from "./mcp-tools.js";

/**
 * MCP prompts (ready-made requests a person picks in their AI app: daily standup, plan my week, project status) and
 * resources (a task, project, document or whiteboard by URI, so an app can attach one to a conversation). Both are
 * built on the tools, so they read exactly what the tools may read, and each read is in the activity log.
 */

interface PromptArg {
  name: string;
  description: string;
  required: boolean;
}
interface Prompt {
  name: string;
  title: string;
  description: string;
  arguments: PromptArg[];
  text(args: Record<string, string>): string;
}

const LANG: PromptArg = { name: "language", description: "Answer language, e.g. Vietnamese or English (default: the language I write in)", required: false };
const inLang = (a: Record<string, string>) => (a.language ? ` Write it in ${a.language}.` : " Write it in the language I use with you.");

export const PROMPTS: Prompt[] = [
  {
    name: "daily_standup",
    title: "Daily standup",
    description: "My standup from workspace: what I finished, what I am on today, and what blocks me.",
    arguments: [LANG],
    text: (a) =>
      "Prepare my daily standup from workspace. Call my_day, then list_my_tasks (status done is not needed: use the recently finished work in my_day's week numbers and get_task for details where useful). " +
      "Format: Yesterday (what I finished), Today (the 3–5 most important open tasks, overdue and due-today first), Blockers (blocked or at-risk tasks, approvals waiting on me). " +
      "Use task codes like WEB-42. Keep it under 150 words." +
      inLang(a),
  },
  {
    name: "plan_my_week",
    title: "Plan my week",
    description: "A day-by-day plan for my open work, by due date and priority, with what to push back.",
    arguments: [LANG, { name: "hours_per_day", description: "Focus hours I have per day (default 6)", required: false }],
    text: (a) =>
      `Plan my week from workspace. Call my_day and list_my_tasks (all pages). Assume ${a.hours_per_day || "6"} focus hours a day. ` +
      "Put overdue and urgent work first, respect due dates, keep blocked tasks out of the plan but list what would unblock them. " +
      "Give a day-by-day plan (Monday to Friday) with task codes, then a short list of tasks to renegotiate (due dates that do not fit). Do not change anything in workspace unless I ask." +
      inLang(a),
  },
  {
    name: "project_status_report",
    title: "Project status report",
    description: "A status report for one project: progress, risks, what is late and what needs a decision.",
    arguments: [{ name: "project", description: "Project code (e.g. WEB) or id", required: true }, LANG],
    text: (a) =>
      `Write a status report for project ${a.project || "(ask me which project)"} from workspace. Call project_progress and get_project for it, and get_task for overdue, blocked or at-risk tasks. ` +
      "Sections: Summary (health, percent done, days left in one line), Progress since last week, Risks and late work (with owners and task codes), Decisions needed, Next steps. Be factual; no filler." +
      inLang(a),
  },
  {
    name: "team_check_in",
    title: "Team check-in",
    description: "For managers: who is overloaded, what is late or blocked, and whom to talk to today.",
    arguments: [LANG],
    text: (a) =>
      "Check on my team in workspace. Call team_workload and blocked_work, then get_task for the tasks they flag. " +
      "Give: the 3 people to talk to today and why (overdue, blocked, overloaded), work that should be reassigned, and one line per department. Use names, not ids (find_people)." +
      inLang(a),
  },
  {
    name: "catch_up_channel",
    title: "Catch up on a channel",
    description: "What happened in a chat channel: decisions, questions waiting for me, and tasks to create.",
    arguments: [{ name: "channel", description: "Channel name, e.g. general", required: true }, LANG],
    text: (a) =>
      `Catch me up on the #${(a.channel || "general").replace(/^#/, "")} channel in workspace. Call read_channel (limit 100) and read_thread for busy threads. ` +
      "Give: decisions made, open questions (especially ones for me; unanswered_questions lists those still waiting), and action items. Offer to create tasks for the action items with create_task, but only create them when I say so." +
      inLang(a),
  },
];

export function promptMessages(name: string, args: Record<string, string>) {
  const p = PROMPTS.find((x) => x.name === name);
  if (!p) throw Object.assign(new Error(`Unknown prompt: ${name}`), { code: -32602 });
  const missing = p.arguments.find((x) => x.required && !args[x.name]?.trim());
  if (missing) throw Object.assign(new Error(`Missing argument: ${missing.name}`), { code: -32602 });
  return { description: p.description, messages: [{ role: "user" as const, content: { type: "text" as const, text: p.text(args) } }] };
}

/** workspace://<kind>/<id or code> → the tool that reads it. */
const KINDS: Record<string, { tool: string; arg: string; name: string; description: string }> = {
  tasks: { tool: "get_task", arg: "id", name: "Task", description: "A task with its comments and subtasks (id or code, e.g. WEB-42)" },
  projects: { tool: "get_project", arg: "project", name: "Project", description: "A project with its open tasks (id or code)" },
  docs: { tool: "read_document", arg: "id", name: "Document", description: "A document's text (id or code, e.g. D-012)" },
  whiteboards: { tool: "read_whiteboard", arg: "id", name: "Whiteboard", description: "The words on a whiteboard (id or code)" },
};

export const RESOURCE_TEMPLATES = Object.entries(KINDS).map(([kind, k]) => ({
  uriTemplate: `workspace://${kind}/{id}`,
  name: k.name,
  description: k.description,
  mimeType: "application/json",
}));

/** My open tasks as resources (up to 25), so an app can offer them to attach; nothing for a workspace key. */
export async function listResources(ctx: ToolContext) {
  if (ctx.principal.type !== "user") return [];
  const r = await ctx.call("work", "GET", "/tasks");
  if (r.status >= 400) return [];
  const tasks = (r.body as { tasks?: { code: string; title: string; status: string }[] }).tasks ?? [];
  return tasks
    .filter((t) => t.status !== "done" && t.status !== "cancelled")
    .slice(0, 25)
    .map((t) => ({ uri: `workspace://tasks/${t.code}`, name: `${t.code} · ${t.title}`, mimeType: "application/json" }));
}

export async function readResource(uri: string, ctx: ToolContext) {
  const m = /^workspace:\/\/([a-z]+)\/([^/?#]{1,64})$/.exec(uri);
  const k = m ? KINDS[m[1]!] : undefined;
  if (!m || !k) throw Object.assign(new Error(`Unknown resource: ${uri}`), { code: -32602 });
  const out = await callTool(k.tool, { [k.arg]: decodeURIComponent(m[2]!) }, ctx);
  const body = out.content[0]!.text;
  if (out.isError) throw Object.assign(new Error(body.split("\n")[0]!), { code: -32002 });
  return { contents: [{ uri, mimeType: "application/json", text: body }] };
}
