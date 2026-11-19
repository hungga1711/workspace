import { Arrow, Canvas, Group, Node, Note } from "./parts";

// Diagrams for the contributor guide (content/docs/advanced). Each is drawn from the code it names: module layout
// from backend/AGENTS.md, tables from backend/server/migrations/work, the event pipeline from docs/events/README.md,
// workflow runs from backend/server/src/modules/work/workflows.ts. When the code and a diagram disagree, the code is right.

/** One module, from the HTTP request to its schema, and the two ways it reaches other modules. */
export function ModuleAnatomy() {
  return (
    <Canvas w={920} h={470} title="Anatomy of a backend module: controller, domain function, transaction, outbox">
      <Node x={20} y={60} w={150} title="gateway" sub="signed principal" lines={["/api/work/tasks/…"]} />

      <Group x={200} y={20} w={480} h={430} label="backend/server/src/modules/work" />
      <Node x={220} y={56} w={210} title="start.ts" sub="migrate · build app · relay" lines={["consumers · scheduleJob"]} />
      <Node x={450} y={56} w={210} title="app.ts" sub="createWorkApp(deps)" lines={["Nest wiring, testable alone"]} />
      <Node x={220} y={160} w={440} title="http/tasks.controller.ts" sub="requirePrincipal → parse(zod) → assertAllowed → withTransaction" accent />
      <Node x={220} y={250} w={210} title="tasks.ts" sub="domain functions" lines={["plain TS over PoolClient", "throw NotFound · Forbidden"]} />
      <Node x={450} y={250} w={210} title="emit()" sub="appendToOutbox, typed" lines={["same transaction"]} />
      <Node x={220} y={366} w={440} title="schema work · role workspace_work" sub="tasks · projects · outbox · processed_events · dead_events" />

      <Node x={720} y={160} w={180} title="ServiceClient" sub="moduleUrl('employee')" lines={["in memory, as the caller"]} />
      <Node x={720} y={270} w={180} title="other modules" sub="consume work.task.*" lines={["home · search · ai"]} dashed />

      <Arrow points={[[170, 88], [195, 88], [195, 188], [220, 188]]} />
      <Arrow points={[[325, 216], [325, 250]]} />
      <Arrow points={[[440, 216], [555, 250]]} />
      <Arrow points={[[325, 322], [325, 366]]} label="SQL" />
      <Arrow points={[[555, 306], [555, 366]]} label="outbox row" />
      <Arrow points={[[660, 188], [720, 188]]} label="read" />
      <Arrow points={[[660, 390], [810, 390], [810, 326]]} label="relay → bus" accent at={0.4} />
      <Arrow points={[[325, 112], [325, 160]]} dashed />

      <Note x={20} y={180}>A lint rule refuses</Note>
      <Note x={20} y={196}>imports between modules.</Note>
      <Note x={20} y={222}>Shared code lives in</Note>
      <Note x={20} y={238}>backend/packages/*.</Note>
    </Canvas>
  );
}

function Table({ x, y, w = 190, name, cols, accent }: { x: number; y: number; w?: number; name: string; cols: string[]; accent?: boolean }) {
  return <Node x={x} y={y} w={w} title={name} lines={cols} accent={accent} />;
}

/** The core of the work schema: projects, tasks and what hangs off them, including agent workflows. */
export function WorkErd() {
  return (
    <Canvas w={920} h={560} title="work schema: projects, tasks, documents and agent workflow runs">
      <Table x={20} y={30} name="projects" cols={["id PK · code UNIQUE", "name · status · due_at", "owner_id · team_id (by value)"]} />
      <Table x={20} y={180} name="board_columns" cols={["id PK · project_id FK", "status · position · wip_limit"]} />
      <Table x={20} y={320} name="documents" cols={["id PK · code UNIQUE", "project_id · visibility", "current_version"]} />
      <Table x={20} y={460} name="document_versions" cols={["document_id FK · version", "content · format · author_id"]} />

      <Table
        x={330}
        y={150}
        w={240}
        name="tasks"
        cols={["id PK · code UNIQUE (T-041)", "project_id FK · column_id · rank", "status · priority · due_at", "assignee_id · owner_id (by value)", "parent_id · custom_fields jsonb", "workflow_id FK"]}
        accent
      />
      <Table x={330} y={30} w={240} name="task_dependencies" cols={["predecessor_id → successor_id"]} />
      <Table x={330} y={390} w={240} name="task_comments · activity" cols={["task_id FK · author_id", "history, pruned by retention"]} />

      <Table x={680} y={30} w={220} name="agent_workflows" cols={["id PK · name · category", "runner: server | local", "steps jsonb · template"]} />
      <Table x={680} y={190} w={220} name="task_agent_runs" cols={["id PK · task_id FK CASCADE", "status · current_step", "steps jsonb (a copy)", "started_by · claimed_by"]} accent />
      <Table x={680} y={370} w={220} name="task_agent_run_questions" cols={["run_id · step_index · round", "questions · answers jsonb", "UNIQUE (run, step, round)"]} />

      <Arrow points={[[115, 120], [115, 180]]} label="1 : n" />
      <Arrow points={[[210, 70], [270, 70], [270, 200], [330, 200]]} label="1 : n" at={0.55} />
      <Arrow points={[[115, 400], [115, 460]]} label="1 : n" />
      <Arrow points={[[450, 80], [450, 150]]} label="n : n" />
      <Arrow points={[[450, 290], [450, 390]]} label="1 : n" />
      <Arrow points={[[790, 112], [790, 190]]} label="name copied" />
      <Arrow points={[[570, 230], [680, 230]]} label="1 : n" />
      <Arrow points={[[570, 270], [620, 270], [620, 70], [680, 70]]} label="workflow_id" dashed at={0.6} />
      <Arrow points={[[790, 290], [790, 370]]} label="1 : n" />

      <Note x={20} y={548}>No foreign keys leave the schema: user, department and channel ids are references by value to other modules.</Note>
    </Canvas>
  );
}

/** One event, from the producer's transaction to every consumer group. */
export function EventSequence() {
  const lanes: [number, string, string][] = [
    [80, "Producer", "work module"],
    [250, "Postgres", "work schema"],
    [420, "Outbox relay", "work module"],
    [590, "EventBus", "in process"],
    [790, "Consumer group", "e.g. home-projector"],
  ];
  const step = (y: number, from: number, to: number, label: string, accent?: boolean, dashed?: boolean) => (
    <Arrow points={[[from, y], [to, y]]} label={label} accent={accent} dashed={dashed} />
  );
  return (
    <Canvas w={920} h={460} title="An event's path: outbox row in the business transaction, relay, bus, idempotent consumer">
      {lanes.map(([x, t, s]) => (
        <g key={t}>
          <Node x={x - 75} y={16} w={150} title={t} sub={s} />
          <line x1={x} y1={72} x2={x} y2={440} className="stroke-fd-border" strokeDasharray="3 4" />
        </g>
      ))}
      {step(104, 80, 250, "BEGIN · rows + outbox")}
      {step(140, 80, 250, "COMMIT", true)}
      {step(176, 250, 420, "NOTIFY", false, true)}
      {step(212, 420, 250, "outbox_claim · SKIP LOCKED")}
      {step(248, 420, 590, "dispatch")}
      {step(284, 590, 790, "deliver to each group", true)}
      {step(320, 790, 250, "INSERT processed_events")}
      {step(356, 790, 250, "handle() · COMMIT")}
      {step(392, 420, 250, "outbox_mark_published")}
      <Note x={20} y={432}>A failing handler retries 5 times (200 to 1600 ms), then lands in dead_events; `dlq replay` re-drives it after the fix.</Note>
      <Note x={20} y={450}>A duplicate delivery inserts no processed_events row, so the handler is skipped: at least once, effectively once.</Note>
    </Canvas>
  );
}

/** The states a run moves through (RunStatus in workflows.ts). */
export function RunStates() {
  return (
    <Canvas w={920} h={400} title="States of a workflow run">
      <Node x={20} y={150} w={120} title="queued" sub="Run pressed" />
      <Node x={230} y={150} w={150} title="running" sub="one step at a time" accent />
      <Node x={460} y={30} w={190} title="waiting_approval" sub="approval step reached" />
      <Node x={460} y={150} w={190} title="waiting_input" sub="the AI asked questions" />
      <Node x={460} y={270} w={190} title="paused" sub="someone held the run" />

      <Group x={720} y={20} w={180} h={320} label="Ends" />
      <Node x={740} y={50} w={140} title="done" sub="after the last step" />
      <Node x={740} y={150} w={140} title="failed" sub="an error, a restart" />
      <Node x={740} y={250} w={140} title="cancelled" sub="someone pressed Stop" />

      <Arrow points={[[140, 178], [230, 178]]} label="claim / kick" />
      <Arrow points={[[380, 160], [460, 62]]} />
      <Arrow points={[[460, 74], [330, 74], [330, 150]]} label="approve" accent at={0.35} />
      <Arrow points={[[650, 58], [690, 58], [690, 10], [280, 10], [280, 150]]} label="rework: the step runs again" dashed at={0.4} />
      <Arrow points={[[380, 178], [460, 178]]} />
      <Arrow points={[[555, 206], [555, 238], [80, 238], [80, 206]]} label="answered → queued" dashed at={0.45} />
      <Arrow points={[[305, 206], [305, 298], [460, 298]]} />
      <Arrow points={[[555, 326], [555, 362], [50, 362], [50, 206]]} label="Continue → queued" dashed at={0.45} />
      <Arrow points={[[355, 150], [355, 110], [700, 110], [700, 78], [740, 78]]} label="last step done" at={0.55} />

      <Note x={20} y={392}>Any active run can end as failed (an error, or the server restarting mid-run) or cancelled (Stop).</Note>
    </Canvas>
  );
}

/** Where a run's steps execute: the server with the company's AI, or the assignee's computer. */
export function Runners() {
  return (
    <Canvas w={920} h={430} title="Two runners: the server with the company's AI, or a local runner on the assignee's computer">
      <Node x={20} y={170} w={170} title="Task page" sub="Run · Approve · Answer" lines={["polls the run"]} />

      <Group x={230} y={20} w={330} h={390} label="workspace server" />
      <Node x={250} y={56} w={290} title="work module · workflows.ts" sub="startRun · approveRun · reworkRun" lines={["task_agent_runs (status, steps)"]} accent />
      <Node x={250} y={176} w={290} title="driveServerRun" sub="runner = server · one step per transaction" lines={["status steps applied here"]} />
      <Node x={250} y={300} w={290} title="ai module · POST /workflows/step" sub="as the person who pressed Run" lines={["budget · policy · MCP tools"]} />

      <Group x={600} y={20} w={300} h={390} label="the assignee's computer" dashed />
      <Node x={620} y={56} w={260} title="workspace-runner.mjs" sub="personal API key wos_…" lines={["POST runner/claim (SKIP LOCKED)", "POST runner/runs/:id/step"]} />
      <Node x={620} y={196} w={260} title="Coding agent" sub="claude -p · codex · gemini · opencode" lines={["works in --dir, your own setup"]} />
      <Node x={620} y={316} w={260} title="command steps" sub="npm test, git push … in a shell" lines={["non-zero exit fails the run"]} />

      <Arrow points={[[190, 198], [250, 100]]} label="start" at={0.4} />
      <Arrow points={[[395, 140], [395, 176]]} />
      <Arrow points={[[395, 260], [395, 300]]} label="ai step" />
      <Arrow points={[[540, 84], [620, 84]]} label="claim · report" both accent />
      <Arrow points={[[750, 140], [750, 196]]} label="stdin" />
      <Arrow points={[[750, 280], [750, 316]]} />
      <Note x={20} y={400}>A local run starts only when the assignee presses Run, and only that person&apos;s runner can claim it.</Note>
    </Canvas>
  );
}

export const ADVANCED_DIAGRAMS = {
  "module-anatomy": ModuleAnatomy,
  "work-erd": WorkErd,
  "event-sequence": EventSequence,
  "run-states": RunStates,
  runners: Runners,
} as const;
