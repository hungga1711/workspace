import { z } from "zod";
import type { Loc } from "./locale.js";
import type { Source, Tool, ToolContext } from "./tools.js";
import { ToolProblem } from "./tools.js";
import { diffText, lineDiff, pageDigest, planImport, sectionsOf, toCsv, type ImportPlan } from "./content-lib.js";
import { clip, en, enc, F, field, L, person, str, work, type Person, type Preview, type Say, type Write } from "./workspace-kit.js";
import { fileText } from "./tools-office.js";

/**
 * The assistant's content tools: pages (summarize, compare versions, turn into tasks, translate),
 * whiteboard diagrams, agent workflows (a draft from a description, how runs went), task import from another tool's
 * export and tasks as CSV. Like every workspace tool they run as the asker through the owning module; the write tools
 * only run after the person approves the card. Pages are left out where Docs is switched off, boards where
 * whiteboards are (`feature`).
 */

interface DocRead {
  document: { id: string; code?: string | null; title: string; version: number };
  content: string;
  format: string;
  text: string;
  viewingVersion: number;
}
const readDoc = (ctx: ToolContext, ref: string, version?: number) => work<DocRead>(ctx, "GET", `/docs/${enc(ref.trim())}?track=0${version ? `&version=${version}` : ""}`);
const docSource = (d: DocRead["document"]): Source => ({ type: "document", id: d.id, title: d.title, url: `/app/work/docs/${d.id}` });

const docRef = z.string().min(1).max(80);
const REF_HELP = "the page: its code (D-012) or the id a search returned (search_workspace first when you only know its title)";
/** A file instead of a page (PDF, Word, PowerPoint, Excel): attached to the question, on a task, or in the Drive. */
const fileIn = { file: z.string().max(200).optional(), fileTask: z.string().max(80).optional(), part: z.number().int().min(1).max(200).optional() };
const fileProps = {
  file: str("instead of a page: a file (PDF, Word, PowerPoint, Excel) attached to the question or an earlier one, a Drive file's name, or a file id"),
  fileTask: str("the task (T-041) the file is attached to (optional)"),
  part: { type: "integer", description: "which part of a long file (1, 2, …)" },
};
const needOne = () => new ToolProblem("Name the page (document) or the file.");

/** Labels of this file's cards (the shared F has the common ones). */
const C = {
  lang: { en: "Language", vi: "Ngôn ngữ" },
  from: { en: "From the page", vi: "Từ trang" },
  board: { en: "Whiteboard", vi: "Bảng trắng" },
  kind: { en: "Diagram", vi: "Sơ đồ" },
  boxes: { en: "Boxes", vi: "Các ô" },
  steps: { en: "Steps", vi: "Các bước" },
  tasks: { en: "Tasks", vi: "Việc" },
  source: { en: "From", vi: "Từ" },
  unknown: { en: "People not found", vi: "Không tìm thấy người" },
} satisfies Record<string, Say>;

// ---- read ----

export const READ: Tool[] = [
  {
    name: "summarize_document",
    description:
      "Read a page (Docs), or a file (PDF, Word, PowerPoint, Excel) with `file`, laid out for summarizing: a page whole when short, else its outline (headings and sizes) and each section, long ones cut; a file's text (a PDF page by page), long ones in parts. Use it when asked to summarize, give the gist of, or brief someone on a page or file; then write the summary yourself (cite a PDF's pages as \"p. 3\").",
    permission: "document.read",
    feature: "docs",
    input: z.object({ document: docRef.optional(), focus: z.string().max(200).optional(), ...fileIn }),
    jsonSchema: {
      type: "object",
      properties: { document: str(REF_HELP), focus: str("what the summary should focus on (optional)"), ...fileProps },
    },
    async run(ctx, input) {
      if (input.file) {
        const f = await fileText(ctx, input.file, input.fileTask, input.part);
        return {
          ok: true,
          content: `${f.head}${input.focus ? `; focus: ${input.focus}` : ""}:\n<untrusted_content>\n${f.text || "(empty)"}\n</untrusted_content>`,
          sources: f.source ? [f.source] : [],
        };
      }
      if (!input.document) throw needOne();
      const d = await readDoc(ctx, input.document);
      const sections = sectionsOf(d.content, d.format);
      const body = pageDigest(sections);
      return {
        ok: true,
        content: `Page "${d.document.title}" (version ${d.document.version}, ${sections.length} sections${input.focus ? `; focus: ${input.focus}` : ""}):\n<untrusted_content>\n${body || "(empty page)"}\n</untrusted_content>`,
        sources: [docSource(d.document)],
      };
    },
  },
  {
    name: "compare_document_versions",
    description:
      "What changed on a page between two versions, line by line (+ added, - removed, with a little context). Without versions: the latest against the one before it; `back` compares the latest with that many versions earlier. Then explain the changes in plain words.",
    permission: "document.read",
    feature: "docs",
    input: z.object({
      document: docRef,
      from: z.number().int().positive().optional(),
      to: z.number().int().positive().optional(),
      back: z.number().int().min(1).max(100).optional(),
    }),
    jsonSchema: {
      type: "object",
      properties: {
        document: str(REF_HELP),
        from: { type: "integer", description: "the older version number (optional)" },
        to: { type: "integer", description: "the newer version number (optional, default the latest)" },
        back: { type: "integer", description: "compare the latest with this many versions before it (optional, default 1)" },
      },
      required: ["document"],
    },
    async run(ctx, input) {
      const latest = await readDoc(ctx, input.document);
      const to = input.to ?? latest.document.version;
      const from = input.from ?? Math.max(1, to - (input.back ?? 1));
      if (from >= to) return { ok: true, content: en(ctx) ? "This page has only one version so far." : "Trang này mới có một phiên bản.", sources: [docSource(latest.document)] };
      const [a, b] = await Promise.all([readDoc(ctx, latest.document.id, from), to === latest.document.version ? latest : readDoc(ctx, latest.document.id, to)]);
      const d = diffText(lineDiff(a.text, b.text));
      return {
        ok: true,
        content: `Page "${latest.document.title}": version ${from} → ${to}, ${d.added} lines added, ${d.removed} removed.\n<untrusted_content>\n${d.text || "(no text changed: formatting only)"}\n</untrusted_content>`,
        sources: [docSource(latest.document)],
      };
    },
  },
  {
    name: "doc_to_tasks",
    description:
      "Read a page (a plan, a spec, meeting notes), or a file with `file` (a PDF, Word, PowerPoint or Excel: a contract, minutes, a brief), to turn it into tasks. Returns its text with instructions: propose the tasks as a short list first, then, when the user agrees, create them with create_task (one call each, `parent` for subtasks). Never create tasks the user did not ask for.",
    permission: "document.read",
    feature: "docs",
    input: z.object({ document: docRef.optional(), project: z.string().max(80).optional(), ...fileIn }),
    jsonSchema: {
      type: "object",
      properties: { document: str(REF_HELP), project: str("the project code the tasks go to (optional)"), ...fileProps },
    },
    async run(ctx, input) {
      const rule =
        "Make one task per concrete action (imperative title, owner if the text names one, due date if it gives one); group steps of one deliverable as subtasks. Skip background and decisions that need no action. List them for the user, then create them with create_task once they agree.";
      if (input.file) {
        const f = await fileText(ctx, input.file, input.fileTask, input.part);
        return {
          ok: true,
          content: [
            `${f.head}, to turn into tasks${input.project ? ` in project ${input.project}` : ""}.`,
            rule,
            `<untrusted_content>\n${f.text || "(empty)"}\n</untrusted_content>`,
          ].join("\n"),
          sources: f.source ? [f.source] : [],
        };
      }
      if (!input.document) throw needOne();
      const d = await readDoc(ctx, input.document);
      const body = pageDigest(sectionsOf(d.content, d.format), 20_000);
      return {
        ok: true,
        content: [
          `Page "${d.document.title}" to turn into tasks${input.project ? ` in project ${input.project}` : ""}.`,
          rule,
          `<untrusted_content>\n${body || "(empty page)"}\n</untrusted_content>`,
        ].join("\n"),
        sources: [docSource(d.document)],
      };
    },
  },
  {
    name: "workflow_run_status",
    description:
      "How the agent workflows have been running: last 30 days' figures, runs going on or waiting for someone, and the recent failures with the step that failed and why. `workflow` narrows to one workflow by name.",
    permission: "task.read",
    input: z.object({ workflow: z.string().max(120).optional(), failedOnly: z.boolean().optional() }),
    jsonSchema: {
      type: "object",
      properties: { workflow: str("a workflow's name (optional)"), failedOnly: { type: "boolean", description: "only failed runs (optional)" } },
      required: [],
    },
    async run(ctx, input) {
      type Step = { title: string; kind: string; state: string };
      type Run = {
        id: string;
        taskId: string;
        taskCode: string;
        taskTitle: string;
        workflowId: string | null;
        workflowName: string;
        status: string;
        currentStep: number;
        steps: Step[];
        updatedAt: string;
      };
      // The Workflow page's own read (work/workflows.ts workflowActivity): `runs` are the latest the asker may see.
      const a = await work<{ stats: Record<string, number>; runs: Run[] }>(ctx, "GET", "/workflows/activity");
      const q = input.workflow ? input.workflow.toLowerCase() : null;
      const runs = (a.runs ?? []).filter((r) => (!q || r.workflowName.toLowerCase().includes(q)) && (!input.failedOnly || r.status === "failed")).slice(0, 15);
      // Why a failure failed: the failed step's log or output, read for the latest few only.
      const why = new Map<string, string>();
      await Promise.all(
        runs
          .filter((r) => r.status === "failed")
          .slice(0, 5)
          .map(async (r) => {
            const full = await work<{ steps: (Step & { log?: string; output?: string })[]; error?: string | null }>(ctx, "GET", `/runs/${enc(r.id)}`).catch(() => null);
            const s = full?.steps.find((x) => x.state === "failed");
            const text = s?.log || s?.output || full?.error || "no log";
            if (full) why.set(r.id, `${s?.title ?? "the run"}: ${clip(text.trim().split("\n").slice(-6).join(" "), 400)}`);
          }),
      );
      const st = a.stats;
      const head = `Last 30 days: ${st.runs30d ?? 0} runs, ${st.done30d ?? 0} done, ${st.failed30d ?? 0} failed. Now: ${st.active ?? 0} running, ${st.waiting ?? 0} waiting for approval, ${st.asking ?? 0} waiting for answers, ${st.paused ?? 0} paused.`;
      const lines = runs.map((r) => {
        const step = r.steps[r.currentStep];
        return `- ${r.workflowName} on ${r.taskCode} ${r.taskTitle}: ${r.status}${step ? ` (step ${r.currentStep + 1}/${r.steps.length} ${step.title})` : ""}, ${r.updatedAt.slice(0, 16).replace("T", " ")}${why.has(r.id) ? `\n  failed at ${why.get(r.id)}` : ""}`;
      });
      return {
        ok: true,
        content: `${head}\n${lines.length ? lines.join("\n") : "No runs match."}`,
        sources: runs.slice(0, 6).map((r) => ({ type: "task" as const, id: r.taskId, title: `${r.taskCode} ${r.taskTitle}`, url: `/app/work/tasks/${r.taskCode}` })),
      };
    },
  },
  {
    name: "import_preview",
    description:
      "Preview importing tasks from another tool's export the user pasted: CSV from Jira, Trello, Asana, ClickUp, Notion or a spreadsheet, or Trello's JSON. Shows what would be created and who could not be matched (people are matched by email, then name). Always preview before import_tasks.",
    permission: "task.read",
    input: z.object({ text: z.string().min(10).max(400_000) }),
    jsonSchema: { type: "object", properties: { text: str("the export, exactly as pasted") }, required: ["text"] },
    async run(ctx, input) {
      const plan = planImport(input.text, await directory(ctx));
      return { ok: true, content: planSummary(plan), sources: [] };
    },
  },
  {
    name: "export_report",
    description:
      "Tasks matching a filter as CSV (code, title, status, priority, assignee, due, done, project labels) the user can copy into a spreadsheet. Filters: project code, assignee name, status (or `open`), overdue, a due window, words in the title.",
    permission: "task.read",
    input: z.object({
      project: z.string().max(80).optional(),
      assignee: z.string().max(120).optional(),
      status: z.enum(["open", "todo", "in_progress", "review", "done", "cancelled"]).optional(),
      overdue: z.boolean().optional(),
      dueFrom: z.string().max(40).optional(),
      dueTo: z.string().max(40).optional(),
      words: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(500).optional(),
    }),
    jsonSchema: {
      type: "object",
      properties: {
        project: str("project code (optional)"),
        assignee: str("a colleague's name, or 'me' (optional)"),
        status: { type: "string", enum: ["open", "todo", "in_progress", "review", "done", "cancelled"] },
        overdue: { type: "boolean", description: "only late tasks" },
        dueFrom: str("ISO date-time with offset (optional)"),
        dueTo: str("ISO date-time with offset (optional)"),
        words: str("words in the title (optional)"),
        limit: { type: "integer", description: "at most this many rows (default 200)" },
      },
      required: [],
    },
    async run(ctx, input) {
      const qs = new URLSearchParams();
      if (input.project) qs.set("projectId", (await work<{ id: string }>(ctx, "GET", `/projects/${enc(input.project)}`)).id);
      const people = await directory(ctx);
      if (input.assignee) qs.set("assigneeId", (await person(ctx, input.assignee)).userId);
      if (input.status) qs.set("status", input.status);
      if (input.overdue) qs.set("overdue", "1");
      for (const k of ["dueFrom", "dueTo"] as const) {
        const v = input[k];
        if (v && !Number.isNaN(Date.parse(v))) qs.set(k, new Date(v).toISOString());
      }
      if (input.words) qs.set("q", input.words);
      qs.set("limit", String(input.limit ?? 200));
      type Row = { code: string; title: string; status: string; priority: string; assigneeId: string | null; dueAt: string | null; completedAt: string | null; labels: string[] };
      const r = await work<{ tasks: Row[]; truncated: boolean }>(ctx, "GET", `/task-export?${qs}`);
      if (!r.tasks.length) return { ok: true, content: en(ctx) ? "No tasks match." : "Không có việc nào khớp.", sources: [] };
      const name = new Map(people.map((p) => [p.userId, p.displayName]));
      const csv = toCsv(
        ["code", "title", "status", "priority", "assignee", "due", "completed", "labels"],
        r.tasks.map((t) => [
          t.code,
          t.title,
          t.status,
          t.priority,
          t.assigneeId ? (name.get(t.assigneeId) ?? "") : "",
          t.dueAt?.slice(0, 10) ?? "",
          t.completedAt?.slice(0, 10) ?? "",
          t.labels.join("; "),
        ]),
      );
      return {
        ok: true,
        content: `${r.tasks.length} tasks${r.truncated ? " (more match; narrow the filter or raise the limit)" : ""}. Show the CSV in a code block:\n${csv}`,
        sources: [],
      };
    },
  },
];

// ---- write ----

const DIAGRAM_KINDS = ["flow", "org", "mindmap"] as const;
const SHAPES = ["box", "round", "decision", "note"] as const;
const STEP_KINDS = ["ai", "check", "approval", "status"] as const;
const CATEGORIES = ["coding", "product", "marketing", "sales", "support", "hr", "finance", "legal", "operations", "creative", "research", "other"] as const;

/** The directory with each member's email (identity has the emails, the employee directory the active people). */
async function directory(ctx: ToolContext): Promise<Person[]> {
  const [people, members] = await Promise.all([
    ctx.services.employee.request<{ employees: Person[] }>("GET", "/employees?all=1", undefined, ctx.principal).catch(() => ({ employees: [] as Person[] })),
    ctx.services.identity
      ? ctx.services.identity.request<{ members: { userId: string; email: string | null }[] }>("GET", "/members", undefined, ctx.principal).catch(() => ({ members: [] }))
      : Promise.resolve({ members: [] as { userId: string; email: string | null }[] }),
  ]);
  const email = new Map(members.members.map((m) => [m.userId, m.email]));
  return people.employees.map((e) => ({ ...e, email: e.email ?? email.get(e.userId) ?? null }));
}

function planSummary(plan: ImportPlan): string {
  if (!plan.tasks.length) return `Nothing to import: no row has a title (${plan.skipped} rows skipped). Check that the first line is the header row.`;
  const by = (k: "status" | "priority") =>
    Object.entries(plan.tasks.reduce<Record<string, number>>((m, t) => ((m[t[k]] = (m[t[k]] ?? 0) + 1), m), {}))
      .map(([s, n]) => `${s} ${n}`)
      .join(", ");
  return [
    `Read as ${plan.system}: ${plan.tasks.length} tasks${plan.skipped ? `, ${plan.skipped} rows without a title skipped` : ""}.`,
    `Status: ${by("status")}. Priority: ${by("priority")}. ${plan.tasks.filter((t) => t.assigneeId).length} with a matched assignee, ${plan.tasks.filter((t) => t.dueAt).length} with a due date, ${plan.tasks.filter((t) => t.parentKey).length} subtasks.`,
    plan.unknownPeople.length ? `Not found in the workspace (left unassigned): ${plan.unknownPeople.slice(0, 15).join(", ")}.` : "Everyone named was found.",
    "First tasks:",
    ...plan.tasks.slice(0, 10).map((t) => `- ${t.title} (${t.status}${t.assigneeLabel ? `, ${t.assigneeLabel}` : ""}${t.dueAt ? `, due ${t.dueAt.slice(0, 10)}` : ""})`),
    "To import, call import_tasks with the same text and the project code.",
  ].join("\n");
}

const listOf = (v: unknown, pick: (x: Record<string, unknown>) => string, n = 12): string => {
  const a = Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
  return a.slice(0, n).map(pick).join(" · ") + (a.length > n ? ` … (+${a.length - n})` : "");
};

export const WRITE: Write[] = [
  {
    title: { en: "Translate a page", vi: "Dịch trang" },
    preview: (i, loc) => ({
      title: L(loc, { en: "Create a translated copy of a page", vi: "Tạo bản dịch của trang" }),
      fields: [...field(loc, C.from, i.document), ...field(loc, C.lang, i.language), ...field(loc, F.title, i.title), ...field(loc, F.text, i.content)],
      note: L(loc, { en: "A new private page; the original stays as it is.", vi: "Một trang riêng mới; trang gốc giữ nguyên." }),
    }),
    tool: {
      name: "translate_document",
      description:
        'Save a translation of a page as a new page (private to the user; the original is unchanged). Read the page first (read_item or summarize_document), translate ALL of it yourself keeping its headings, lists and tables in Markdown, then call this with the translated title and content. To translate a FILE (PDF, Word, PowerPoint), read it with read_office_file and save the translation with create_word_document (format "pdf" for a PDF) instead.',
      permission: "document.create",
      feature: "docs",
      input: z.object({
        document: docRef,
        language: z.string().min(2).max(40),
        title: z.string().min(1).max(200),
        content: z.string().min(1).max(200_000),
      }),
      jsonSchema: {
        type: "object",
        properties: {
          document: str(REF_HELP),
          language: str("the language translated into, e.g. English, Tiếng Việt"),
          title: str("the translated title"),
          content: str("the whole translated page, Markdown"),
        },
        required: ["document", "language", "title", "content"],
      },
      async run(ctx, input) {
        const src = await readDoc(ctx, input.document);
        const d = await work<{ id: string; title: string }>(ctx, "POST", "/docs", { title: input.title, content: input.content, projectId: null, format: "markdown" });
        return {
          ok: true,
          content: `Created "${input.title}", the ${input.language} translation of "${src.document.title}".`,
          sources: [{ type: "document", id: d.id, title: input.title, url: `/app/work/docs/${d.id}` }, docSource(src.document)],
        };
      },
    },
  },
  {
    title: { en: "Draw on a whiteboard", vi: "Vẽ lên bảng trắng" },
    preview: (i, loc) => ({
      title: L(
        loc,
        i.board
          ? { en: `Draw a diagram on ${String(i.board)}`, vi: `Vẽ sơ đồ lên ${String(i.board)}` }
          : { en: "Create a whiteboard with a diagram", vi: "Tạo bảng trắng có sơ đồ" },
      ),
      fields: [
        ...field(loc, C.board, i.board ?? i.title),
        ...field(loc, C.kind, i.kind),
        ...field(
          loc,
          C.boxes,
          listOf(i.nodes, (n) => String(n.label ?? ""), 16),
        ),
      ],
      note: L(loc, { en: "Added beside what is already on the board; nothing there changes.", vi: "Thêm cạnh nội dung đang có; không thay đổi gì trên bảng." }),
    }),
    tool: {
      name: "create_whiteboard_diagram",
      description:
        "Draw a diagram on a whiteboard: a flow (process steps top to bottom, `decision` boxes for yes/no), an org chart (manager → report edges) or a mind map (first node is the centre). Give nodes (short labels) and edges (from → to, optional label like Yes/No). `board` adds it beside what an existing board holds; without it, a new board titled `title` is created.",
      permission: "document.create",
      feature: "whiteboards",
      input: z.object({
        board: z.string().max(80).optional(),
        title: z.string().max(200).optional(),
        kind: z.enum(DIAGRAM_KINDS).default("flow"),
        nodes: z
          .array(z.object({ id: z.string().min(1).max(40), label: z.string().min(1).max(200), shape: z.enum(SHAPES).optional() }))
          .min(1)
          .max(80),
        edges: z
          .array(z.object({ from: z.string().max(40), to: z.string().max(40), label: z.string().max(60).optional() }))
          .max(200)
          .default([]),
      }),
      jsonSchema: {
        type: "object",
        properties: {
          board: str("an existing board's code (W-003) or id (optional)"),
          title: str("the new board's title, or a heading above the diagram"),
          kind: { type: "string", enum: [...DIAGRAM_KINDS] },
          nodes: {
            type: "array",
            items: {
              type: "object",
              properties: { id: str("short id, e.g. n1"), label: str("the box's text"), shape: { type: "string", enum: [...SHAPES] } },
              required: ["id", "label"],
            },
          },
          edges: {
            type: "array",
            items: { type: "object", properties: { from: str("node id"), to: str("node id"), label: str("optional") }, required: ["from", "to"] },
          },
        },
        required: ["kind", "nodes"],
      },
      async run(ctx, input) {
        const ids = new Set(input.nodes.map((n: { id: string }) => n.id));
        const bad = (input.edges as { from: string; to: string }[]).find((e) => !ids.has(e.from) || !ids.has(e.to));
        if (bad) throw new ToolProblem(`Edge ${bad.from} → ${bad.to} names a node that is not in nodes.`);
        const ref = input.board
          ? input.board
          : (await work<{ id: string }>(ctx, "POST", "/whiteboards", { title: (input.title ?? "Diagram").slice(0, 200), template: "blank", visibility: "private" })).id;
        const r = await work<{ id: string; code: string; title: string; added: number }>(ctx, "POST", `/whiteboards/${enc(ref)}/diagram`, {
          kind: input.kind,
          ...(input.board && input.title ? { title: input.title } : {}),
          nodes: input.nodes,
          edges: input.edges,
        });
        return {
          ok: true,
          content: `${input.board ? "Drew" : "Created the board and drew"} a ${input.kind} with ${input.nodes.length} boxes on ${r.code} "${r.title}".`,
          sources: [{ type: "document", id: r.id, title: `${r.code} ${r.title}`, url: `/app/work/whiteboards/${r.code || r.id}` }],
        };
      },
    },
  },
  {
    title: { en: "Create a workflow", vi: "Tạo workflow" },
    preview: (i, loc) => ({
      title: L(loc, { en: `Create the workflow "${String(i.name ?? "")}"`, vi: `Tạo workflow "${String(i.name ?? "")}"` }),
      fields: [
        ...field(loc, F.details, i.description),
        ...field(
          loc,
          C.steps,
          listOf(i.steps, (s) => `${String(s.title ?? "")} (${String(s.kind ?? "")})`),
        ),
      ],
      note: L(loc, {
        en: "Saved as a draft in the library: it runs only when someone hands a task to it.",
        vi: "Lưu nháp trong thư viện: chỉ chạy khi có người giao việc cho nó.",
      }),
    }),
    tool: {
      name: "create_workflow_from_description",
      description:
        "Create an agent workflow from a description, as a draft in the workflow library (it never runs by itself: someone must hand a task to it). Steps in order: `ai` (the company AI does something; `prompt` says what, it may use {{task.title}} and {{task.description}}), `check` (the AI checks the previous result against `criteria` and sends it back if it fails), `approval` (a person approves), `status` (move the task to a status). Keep it to the steps the description needs.",
      permission: "ai.use",
      input: z.object({
        name: z.string().min(1).max(120),
        description: z.string().max(1000).default(""),
        category: z.enum(CATEGORIES).default("other"),
        steps: z
          .array(
            z.object({
              title: z.string().min(1).max(120),
              kind: z.enum(STEP_KINDS),
              prompt: z.string().max(8000).optional(),
              criteria: z.string().max(4000).optional(),
              status: z.enum(["todo", "in_progress", "review", "done"]).optional(),
            }),
          )
          .min(1)
          .max(12),
      }),
      jsonSchema: {
        type: "object",
        properties: {
          name: str("the workflow's name"),
          description: str("what it is for, one or two sentences"),
          category: { type: "string", enum: [...CATEGORIES] },
          steps: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: str("short step name"),
                kind: { type: "string", enum: [...STEP_KINDS] },
                prompt: str("ai: what to do"),
                criteria: str("check: what a good result must meet"),
                status: { type: "string", enum: ["todo", "in_progress", "review", "done"], description: "status: the status to set" },
              },
              required: ["title", "kind"],
            },
          },
        },
        required: ["name", "steps"],
      },
      async run(ctx, input) {
        type StepIn = { title: string; kind: (typeof STEP_KINDS)[number]; prompt?: string; criteria?: string; status?: string };
        const steps = (input.steps as StepIn[]).map((s, i) => {
          if (s.kind === "ai" && !s.prompt?.trim()) throw new ToolProblem(`Step ${i + 1} (${s.title}) is an ai step and needs a prompt.`);
          if (s.kind === "check" && !s.criteria?.trim()) throw new ToolProblem(`Step ${i + 1} (${s.title}) is a check and needs criteria.`);
          if (s.kind === "status" && !s.status) throw new ToolProblem(`Step ${i + 1} (${s.title}) is a status step and needs a status.`);
          return {
            title: s.title,
            kind: s.kind,
            ...(s.kind === "ai" ? { prompt: s.prompt } : {}),
            ...(s.kind === "check" ? { criteria: s.criteria, ...(s.prompt ? { prompt: s.prompt } : {}) } : {}),
            ...(s.kind === "status" ? { status: s.status } : {}),
            ...(s.kind === "approval" ? { approver: "assignee" as const } : {}),
          };
        });
        const w = await work<{ id: string; name: string }>(ctx, "POST", "/workflows", { name: input.name, description: input.description, category: input.category, steps });
        return {
          ok: true,
          content: `Created the workflow "${w.name ?? input.name}" with ${steps.length} steps. It runs only when a task is handed to it.`,
          sources: [{ type: "workflow", id: w.id, title: w.name ?? input.name, url: `/app/ai/workflows/${w.id}` }],
        };
      },
    },
  },
  {
    title: { en: "Import tasks", vi: "Nhập việc" },
    preview: (i, loc): Preview => {
      const plan = planImport(String(i.text ?? ""), []);
      return {
        title: L(loc, { en: `Import ${plan.tasks.length} tasks into ${String(i.project ?? "")}`, vi: `Nhập ${plan.tasks.length} việc vào ${String(i.project ?? "")}` }),
        fields: [
          ...field(loc, F.project, i.project),
          ...field(loc, C.source, plan.system),
          ...field(
            loc,
            C.tasks,
            plan.tasks
              .slice(0, 8)
              .map((t) => t.title)
              .join(" · ") + (plan.tasks.length > 8 ? ` … (+${plan.tasks.length - 8})` : ""),
          ),
        ],
        note: L(loc, {
          en: "People are matched by email, then by name; anyone not found leaves the task unassigned.",
          vi: "Người làm được khớp theo email rồi theo tên; ai không tìm thấy thì việc để trống người làm.",
        }),
      };
    },
    tool: {
      name: "import_tasks",
      description:
        "Import tasks from a pasted export (the same text import_preview read) into a project: titles, descriptions, status, priority, assignee (matched by email, then name), due date, labels and subtasks. Preview first with import_preview and say what will happen.",
      permission: "task.create",
      input: z.object({ project: z.string().min(1).max(80), text: z.string().min(10).max(400_000) }),
      jsonSchema: {
        type: "object",
        properties: { project: str("the project code the tasks go into"), text: str("the export, exactly as pasted") },
        required: ["project", "text"],
      },
      async run(ctx, input) {
        const plan = planImport(input.text, await directory(ctx));
        if (!plan.tasks.length) throw new ToolProblem("No row of the export has a title: nothing to import.");
        if (plan.tasks.length > 1000) throw new ToolProblem(`The export has ${plan.tasks.length} tasks; import at most 1000 at a time.`);
        const project = await work<{ id: string; code: string; name: string }>(ctx, "GET", `/projects/${enc(input.project)}`);
        const r = await work<{ created?: number }>(ctx, "POST", `/projects/${project.id}/import`, {
          system: plan.system,
          tasks: plan.tasks.map(({ assigneeLabel: _a, ...t }) => t),
        });
        const n = r.created ?? plan.tasks.length;
        return {
          ok: true,
          content: `Imported ${n} tasks into ${project.code} ${project.name}.${plan.unknownPeople.length ? ` Left unassigned (not found): ${plan.unknownPeople.slice(0, 10).join(", ")}.` : ""}`,
          sources: [{ type: "project", id: project.id, title: `${project.code} ${project.name}`, url: `/app/work/projects/${project.id}` }],
        };
      },
    },
  },
];

export const TITLES: Record<string, Say> = {
  summarize_document: { en: "Read a page to summarize", vi: "Đọc trang để tóm tắt" },
  compare_document_versions: { en: "Compare page versions", vi: "So sánh phiên bản trang" },
  doc_to_tasks: { en: "Read a page for tasks", vi: "Đọc trang để tách việc" },
  workflow_run_status: { en: "Check workflow runs", vi: "Xem các lần chạy workflow" },
  import_preview: { en: "Preview an import", vi: "Xem trước khi nhập" },
  export_report: { en: "Export tasks as CSV", vi: "Xuất việc ra CSV" },
};

/** For tests: the card a write tool shows. */
export const cardOf = (name: string, input: Record<string, unknown>, loc: Loc) => WRITE.find((w) => w.tool.name === name)?.preview(input, loc) ?? null;
