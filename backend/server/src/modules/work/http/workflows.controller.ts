import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, Inject, Param, Post, Put, Query, Req } from "@nestjs/common";
import { assertAllowed, parse, requirePrincipal } from "@workspace/service-kit";
import { newId, runWithContext, withTransaction } from "@workspace/shared";
import { getTask, insertComment } from "../tasks.js";
import type { Request } from "express";
import { z } from "zod";
import { runActivityQuery, runAnswerBody, runApproveBody, runReworkBody, runStartBody } from "@workspace/contracts";
import { resolveRef } from "../ref.js";
import {
  answerRun,
  approveRun,
  reworkRun,
  retryRun,
  askThread,
  archiveWorkflow,
  cancelRun,
  checkLink,
  claimLocalRun,
  collected,
  confirmArtifact,
  duplicateWorkflow,
  getWorkflow,
  kickServerRun,
  listRunners,
  listRuns,
  listWorkflows,
  localRunStatus,
  oneRun,
  nextLocalStep,
  noteServerStep,
  openAsks,
  openApprovals,
  pauseRun,
  reportEnv,
  reportLocalStep,
  requestArtifact,
  resumeRun,
  runActivity,
  runTimeline,
  runDto,
  saveWorkflow,
  setTaskWorkflow,
  startRun,
  templatesFor,
  workflowActivity,
  workflowDto,
  workflowEstimate,
  ACTIVITY_KINDS,
  CATEGORIES,
  CHECK_HINT,
  DESCRIPTION_MAX,
  LIMITS,
  PREVIOUS_MAX,
  RESOURCES_MAX,
  STEP_KINDS,
  type Engine,
} from "../workflows.js";
import { mintQuickActions, redeemQuickAction } from "../quick-actions.js";
import { makeHookAddress, receiveHook, triggerActivity } from "../workflow-triggers.js";
import { WorkControllerBase } from "./base.controller.js";
import { WINDOWS, workflowInsights } from "../workflows/insights.js";
import { ASK_HINT, DECIDE_HINT } from "../agent-ask.js";
import { CONTEXT_MAX } from "../workflow-context.js";
import { WORKFLOWS, guard, statusEnum } from "./common.js";

/** Lines of a step's activity as a runner or the ai module sends them (workflows/activity.ts clips each text). */
const activityLines = z
  .array(z.object({ kind: z.enum(ACTIVITY_KINDS), tool: z.string().max(200).optional(), text: z.string().max(4000).optional(), detail: z.string().max(8000).optional() }))
  .max(200);

/**
 * How a step's instruction is put together (workflows/render.ts, agent-ask.ts composePrompt), for the workflow pages
 * to draw each step's real input: what the placeholders carry and how much, and the lines added at the end.
 */
const PROMPTING = {
  limits: { description: DESCRIPTION_MAX, context: CONTEXT_MAX, previous: PREVIOUS_MAX, resources: RESOURCES_MAX },
  hints: { ask: ASK_HINT, decide: DECIDE_HINT, check: CHECK_HINT },
};

const step = z.object({
  key: z.string().trim().max(40).default(""),
  title: z.string().trim().min(1).max(120),
  kind: z.enum(STEP_KINDS as [string, ...string[]]).transform((k) => k as (typeof STEP_KINDS)[number]),
  prompt: z.string().max(LIMITS.prompt).optional(),
  command: z.string().max(2000).optional(),
  status: statusEnum.optional(),
  model: z.string().trim().max(260).optional(),
  role: z.string().max(4000).optional(),
  tools: z.boolean().optional(),
  resources: z.boolean().optional(),
  ask: z.boolean().optional(),
  maxOutput: z.number().int().min(500).max(8000).optional(),
  timeoutMin: z.number().int().min(1).max(LIMITS.stepMinutes[1]).optional(),
  retries: z.number().int().min(0).max(3).optional(),
  criteria: z.string().max(4000).optional(),
  attempts: z.number().int().min(0).max(5).optional(),
  onFail: z.enum(["stop", "continue"]).optional(),
  approver: z.enum(["editors", "owner", "assignee", "starter", "person"]).optional(),
  approverId: z.string().max(40).optional(),
});
const workflow = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).default(""),
  category: z.enum(CATEGORIES).default("other"),
  // An older workflow only says where it runs; `config.environment` says it now (model.ts normalizeConfig).
  runner: z.enum(["server", "local"]).optional(),
  steps: z.array(step).min(1).max(LIMITS.steps),
  // Checked field by field in model.ts (normalizeConfig, validateWorkflow); here only its size.
  config: z
    .record(z.string(), z.unknown())
    .refine((v) => JSON.stringify(v).length < 60_000, "the workflow's settings are too large")
    .optional(),
  template: z.string().max(40).nullable().optional(),
});

/** Agent workflows: the library, a task's workflow and its runs, and the local runner's queue (workflows.ts). */
@Controller()
export class WorkflowsController extends WorkControllerBase {
  // The run engine's own dependencies (app.ts): the ai module with a long timeout, storage, a member's principal.
  @Inject(WORKFLOWS) private readonly engine!: Engine;

  @Get("workflows")
  async list(@Req() req: Request) {
    const p = requirePrincipal(req);
    assertAllowed(p, "task.read");
    const h = req.headers["x-locale"];
    const lang = h === "vi" || h === "zh" || h === "es" ? h : "en";
    return withTransaction(this.pool, async (c) => ({
      workflows: await listWorkflows(c, p),
      templates: templatesFor(lang),
      prompting: PROMPTING,
      runners: await listRunners(c, p),
    }));
  }

  // The Workflow page's figures, each workflow's use and the latest runs, read apart from the list so a failure here
  // never takes the workflows down with it.
  @Get("workflows/activity")
  async activity(@Req() req: Request) {
    const p = requirePrincipal(req);
    assertAllowed(p, "task.read");
    return withTransaction(this.pool, (c) => workflowActivity(c, p));
  }

  @Post("workflows")
  async create(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "ai.use");
    const b = parse(workflow, body);
    return guard(() => withTransaction(this.pool, (c) => saveWorkflow(c, p, null, b)));
  }

  @Put("workflows/:id")
  async update(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(workflow, body);
    return guard(() => withTransaction(this.pool, (c) => saveWorkflow(c, p, id, b)));
  }

  // A link added as reference: can a run read it? (workflows/links.ts; public addresses only.)
  @Post("workflows/links/check")
  @HttpCode(200)
  async link(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "ai.use");
    const b = parse(z.object({ url: z.string().trim().url().max(1000) }), body);
    return checkLink(b.url);
  }

  // How the workflows perform (workflows/insights.ts): tokens, time, failures and what to change, over 7, 30 or 90 days.
  @Get("workflows/insights")
  async insights(@Req() req: Request, @Query() query: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "task.read");
    const q = parse(z.object({ days: z.coerce.number().int().optional(), workflowId: z.string().max(40).optional() }), query);
    const days = (WINDOWS as readonly number[]).includes(q.days ?? 30) ? (q.days ?? 30) : 30;
    return guard(() => withTransaction(this.pool, (c) => workflowInsights(c, p, days, q.workflowId)));
  }

  @Get("workflows/:id")
  async one(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "task.read");
    return guard(() => withTransaction(this.pool, async (c) => workflowDto(await getWorkflow(c, id), p)));
  }

  @Get("workflows/:id/estimate")
  async estimate(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "task.read");
    return guard(() => withTransaction(this.pool, (c) => workflowEstimate(c, id)));
  }

  // How the workflow has started by itself lately (workflow-triggers.ts): each fire and what came of it, the
  // addresses made for it, who its runs act as.
  @Get("workflows/:id/triggers")
  async triggers(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "task.read");
    return guard(() => withTransaction(this.pool, (c) => triggerActivity(c, p, id)));
  }

  // The secret address a system outside posts to: made (or replaced) here, shown this once.
  @Post("workflows/:id/triggers/:triggerId/address")
  async hookAddress(@Req() req: Request, @Param("id") id: string, @Param("triggerId") triggerId: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "ai.use");
    return guard(() => withTransaction(this.pool, (c) => makeHookAddress(c, p, id, triggerId)));
  }

  /** A post to a workflow's address, passed on by the gateway (`POST /api/hooks/:token`, no sign-in: the token is the credential). */
  @Post("internal/workflow-hooks/:token")
  @HttpCode(202)
  async hook(@Req() req: Request, @Param("token") token: string, @Body() body: unknown) {
    if (requirePrincipal(req).type !== "service") throw new ForbiddenException("the gateway only");
    return guard(() => runWithContext({ actorId: "system", requestId: String(req.requestId ?? newId()) }, () => withTransaction(this.pool, (c) => receiveHook(c, token, body))));
  }

  @Post("workflows/:id/duplicate")
  async duplicate(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "ai.use");
    const b = parse(z.object({ name: z.string().trim().max(120).optional() }), body ?? {});
    return guard(() => withTransaction(this.pool, (c) => duplicateWorkflow(c, p, id, b.name)));
  }

  @Delete("workflows/:id")
  @HttpCode(204)
  async remove(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    await guard(() => withTransaction(this.pool, (c) => archiveWorkflow(c, p, id)));
  }

  @Put("tasks/:ref/workflow")
  async setWorkflow(@Req() req: Request, @Param("ref") ref: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(z.object({ workflowId: z.string().max(40).nullable() }), body);
    const r = await guard(() => withTransaction(this.pool, async (c) => setTaskWorkflow(c, p, await resolveRef(c, "task", ref), b.workflowId)));
    // A workflow set to start by itself has started (workflows.ts setTaskWorkflow).
    if (r.run?.runner === "server") this.kick(req, r.run.id);
    return { workflowId: r.workflowId, run: r.run ? runDto(r.run) : null };
  }

  private kick(req: Request, runId: string) {
    kickServerRun(this.engine, requirePrincipal(req), runId, String(req.requestId ?? ""));
  }

  @Get("tasks/:ref/runs")
  async runs(@Req() req: Request, @Param("ref") ref: string) {
    const p = requirePrincipal(req);
    return guard(() => withTransaction(this.pool, async (c) => ({ runs: await listRuns(c, p, await resolveRef(c, "task", ref)) })));
  }

  @Post("tasks/:ref/runs")
  async start(@Req() req: Request, @Param("ref") ref: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(runStartBody, body ?? {});
    const r = await guard(() => withTransaction(this.pool, async (c) => startRun(c, p, await resolveRef(c, "task", ref), b.inputs ?? {})));
    if (r.runner === "server") this.kick(req, r.id);
    return runDto(r);
  }

  /** One run by its id, as the task's list gives it: steps, questions asked, and what the caller may do on it. */
  @Get("runs/:id")
  async run(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    return guard(() => withTransaction(this.pool, (c) => oneRun(c, p, id)));
  }

  @Post("runs/:id/cancel")
  async cancel(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    return guard(() => withTransaction(this.pool, (c) => cancelRun(c, p, id)));
  }

  // Pause holds the run after the step in progress; Continue goes on from the next step (workflows.ts).
  @Post("runs/:id/pause")
  async pause(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    return guard(() => withTransaction(this.pool, (c) => pauseRun(c, p, id)));
  }

  @Post("runs/:id/resume")
  async resume(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    const { run, kick } = await guard(() => withTransaction(this.pool, (c) => resumeRun(c, p, id)));
    if (kick) this.kick(req, run.id);
    return runDto(run);
  }

  @Post("runs/:id/approve")
  async approve(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(runApproveBody, body ?? {});
    const r = await guard(() => withTransaction(this.pool, (c) => approveRun(c, p, id, b.note)));
    if (r.runner === "server") this.kick(req, r.id);
    return runDto(r);
  }

  // Changes asked instead of an approval: the AI step under review runs again with the request (workflows.ts reworkRun).
  @Post("runs/:id/rework")
  async rework(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(runReworkBody, body ?? {});
    const r = await guard(() => withTransaction(this.pool, (c) => reworkRun(c, p, id, b.note)));
    if (r.runner === "server") this.kick(req, r.id);
    return runDto(r);
  }

  // A failed run goes again from the step that failed, keeping what was made before it (workflows.ts retryRun).
  @Post("runs/:id/retry")
  async retry(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    const r = await guard(() => withTransaction(this.pool, (c) => retryRun(c, p, id)));
    if (r.runner === "server") this.kick(req, r.id);
    return runDto(r);
  }

  // An AI step's questions (agent-ask.ts): what waits for me (the chat sidebar asks every half minute while the tab
  // is visible), one run's rounds (the temporary conversation), and the answer that lets the run go on.
  @Get("agent-questions/open")
  async openQuestions(@Req() req: Request) {
    const p = requirePrincipal(req);
    assertAllowed(p, "task.read");
    return withTransaction(this.pool, async (c) => ({ asks: await openAsks(c, p), approvals: await openApprovals(c, p) }));
  }

  // The whole run's activity in order, a page at a time, for its timeline (components/workflows/run/RunReplay.tsx).
  @Get("runs/:id/timeline")
  async timeline(@Req() req: Request, @Param("id") id: string, @Query() query: unknown) {
    const p = requirePrincipal(req);
    const q = parse(z.object({ after: z.coerce.number().int().min(0).optional() }), query);
    return guard(() => withTransaction(this.pool, (c) => runTimeline(c, p, id, q.after)));
  }

  // What the agent did in one step, as it happens (workflows/activity.ts): the pipeline asks for the lines after the
  // last one it has while the step works.
  @Get("runs/:id/activity")
  async stepActivity(@Req() req: Request, @Param("id") id: string, @Query() query: unknown) {
    const p = requirePrincipal(req);
    const q = parse(runActivityQuery, query);
    return guard(() => withTransaction(this.pool, (c) => runActivity(c, p, id, q.step, q.after)));
  }

  @Get("runs/:id/questions")
  async questions(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    return guard(() => withTransaction(this.pool, (c) => askThread(c, p, id)));
  }

  @Post("agent-questions/:id/answer")
  async answer(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(runAnswerBody, body ?? {});
    const r = await guard(() => withTransaction(this.pool, (c) => answerRun(c, p, id, b)));
    if (r.runner === "server") this.kick(req, r.id);
    return runDto(r);
  }

  /**
   * The assistant's answer to an @AI in a task's comments (ai/mention.ts): a comment marked with the agent's name, in
   * the name of the person who asked, who must be able to read the task. The ai module only.
   */
  @Post("internal/tasks/:id/agent-comments")
  async agentComment(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    if (p.type !== "service" || !p.grants.some((g) => g.permission === "agent.post" && g.scope === "PLATFORM")) throw new ForbiddenException("ai module only");
    const b = parse(z.object({ askerId: z.string().min(1).max(60), agent: z.string().trim().min(1).max(40), body: z.string().trim().min(1).max(10_000) }), body);
    const asker = await this.engine.resolve(b.askerId);
    return runWithContext({ actorId: asker.id, requestId: String(req.requestId ?? newId()) }, () =>
      guard(() =>
        withTransaction(this.pool, async (c) => {
          const t = await getTask(c, asker, await resolveRef(c, "task", id));
          return insertComment(c, asker, t, b.body, b.agent);
        }),
      ),
    );
  }

  /** What a step of the company's AI is doing, said by the ai module while it works on it (ai/assist.ts workflowStep). */
  @Post("internal/runs/:id/activity")
  async serverActivity(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    if (p.type !== "service" || !p.grants.some((g) => g.permission === "agent.post" && g.scope === "PLATFORM")) throw new ForbiddenException("ai module only");
    const b = parse(z.object({ step: z.number().int().min(0), events: activityLines }), body);
    return guard(() => withTransaction(this.pool, (c) => noteServerStep(c, id, b.step, b.events)));
  }

  /**
   * The buttons a push about a waiting run may carry for one person (quick-actions.ts), asked for by the home module
   * as it sends that push, only for people who turned quick actions on. The home module only.
   */
  @Post("internal/quick-actions")
  async quickActions(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    if (p.type !== "service" || !p.grants.some((g) => g.permission === "run.quick_action" && g.scope === "PLATFORM")) throw new ForbiddenException("home module only");
    const b = parse(
      z.object({ userId: z.string().min(1).max(60), runId: z.string().max(40), waitId: z.string().max(80).optional(), questionId: z.string().max(40).optional() }),
      body,
    );
    return guard(() => withTransaction(this.pool, (c) => mintQuickActions(this.engine, c, b.userId, b)));
  }

  /** A notification's button was pressed (the service worker, with the person's session): the action is done once. */
  @Post("quick-actions/redeem")
  @HttpCode(200)
  async quickRedeem(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(z.object({ token: z.string().min(10).max(200) }), body);
    const done = await guard(() => withTransaction(this.pool, (c) => redeemQuickAction(c, p, b.token)));
    if (done.run.runner === "server") this.kick(req, done.run.id);
    return { ok: true, action: done.action, runId: done.run.id };
  }

  // A runner (public/runner/workspace-runner.mjs), signed in with its owner's personal API key. Protocol 2: it claims a
  // run, prepares the environment and reports it, then asks for one step at a time; this server renders every
  // instruction and decides what comes next (docs/architecture/agent-workflows.md).
  @Post("runner/claim")
  async claim(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(
      z.object({
        device: z.string().max(80).default("runner"),
        protocol: z.number().int().optional(),
        shared: z.boolean().optional(),
        docker: z.boolean().optional(),
        agent: z.string().max(400).optional(),
        os: z.string().max(40).optional(),
        version: z.string().max(20).optional(),
      }),
      body ?? {},
    );
    return guard(() => withTransaction(this.pool, (c) => claimLocalRun(this.engine, c, p, b)));
  }

  // The runner's check between steps and during a long one (stop on cancel; finish the step on pause), and its sign of life.
  @Get("runner/runs/:id")
  async runnerStatus(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    return guard(() => withTransaction(this.pool, (c) => localRunStatus(c, p, id)));
  }

  @Post("runner/runs/:id/env")
  async env(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(
      z.object({
        state: z.enum(["preparing", "ready", "failed"]),
        isolation: z.enum(["container", "folder", "computer"]).optional(),
        image: z.string().max(200).optional(),
        network: z.enum(["on", "off"]).optional(),
        agentIn: z.enum(["container", "host"]).optional(),
        assets: z.number().int().min(0).max(1000).optional(),
        log: z.string().max(40000).optional(),
      }),
      body,
    );
    return guard(() => withTransaction(this.pool, (c) => reportEnv(this.engine, c, p, id, b)));
  }

  @Post("runner/runs/:id/next")
  async next(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    return guard(() => withTransaction(this.pool, (c) => nextLocalStep(this.engine, c, p, id)));
  }

  @Post("runner/runs/:id/step")
  async report(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(
      z.object({
        index: z.number().int().min(0),
        // "log": more of the step's output as it runs. "ask": the agent's questions (also read from a `workspace-ask`
        // block in a "done" AI step's output).
        state: z.enum(["log", "done", "failed", "ask"]),
        output: z.string().max(40000).optional(),
        log: z.string().max(40000).optional(),
        // What the agent did since the last report: actions, words, results (shown live in the pipeline).
        activity: activityLines.optional(),
        questions: z.array(z.unknown()).max(20).optional(),
        model: z.string().max(200).optional(),
        exitCode: z.number().int().optional(),
        timeout: z.boolean().optional(),
      }),
      body,
    );
    return guard(() => withTransaction(this.pool, (c) => reportLocalStep(this.engine, c, p, id, b)));
  }

  // The files a run wrote to its `out` folder, handed back one by one (presigned upload, like any task attachment).
  @Post("runner/runs/:id/artifacts")
  async artifact(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(z.object({ name: z.string().trim().min(1).max(255), contentType: z.string().min(1).max(127), size: z.number().int() }), body);
    return guard(() => withTransaction(this.pool, (c) => requestArtifact(this.engine, c, p, id, b)));
  }

  @Post("runner/runs/:id/artifacts/:fileId/confirm")
  async artifactDone(@Req() req: Request, @Param("id") id: string, @Param("fileId") fileId: string) {
    const p = requirePrincipal(req);
    return guard(() => withTransaction(this.pool, (c) => confirmArtifact(this.engine, c, p, id, fileId)));
  }

  @Post("runner/runs/:id/collected")
  async collected(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(
      z.object({
        log: z.string().max(8000).optional(),
        // The files that could not be handed back (runner 3 and later); an older runner says it only in the log.
        missing: z
          .array(z.object({ name: z.string().max(300), why: z.string().max(300) }))
          .max(200)
          .optional(),
      }),
      body ?? {},
    );
    return guard(() => withTransaction(this.pool, (c) => collected(this.engine, c, p, id, b)));
  }
}
