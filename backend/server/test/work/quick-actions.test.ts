import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import type { INestApplication } from "@nestjs/common";
import pg from "pg";
import { migrate, signInternalToken, PRINCIPAL_HEADER, S3Storage, type ServiceClient } from "@workspace/service-kit";
import { newId, runWithContext, withTransaction, type Grant, type Principal } from "@workspace/shared";
import type { EventEnvelope } from "@workspace/contracts";
import { createHomeApp } from "../../src/modules/home/app.js";
import { project } from "../../src/modules/home/projector.js";
import { sendInstantPushes, type QuickLoader } from "../../src/modules/home/push.js";
import { createWorkApp } from "../../src/modules/work/app.js";

/**
 * A run that waits for a person, from the wait to the phone: who is told (home's inbox, once per wait,
 * settled when anyone acts), what the push carries (buttons only for people who turned quick actions on), and the
 * token behind a button (work/quick-actions.ts): one person, one wait, one use, an hour.
 *
 * The work module's events are handed to home's projector by hand, so the test does not depend on a relay. People
 * are named per run: the test database is shared with other suites.
 */
const SECRET = "dev-internal-secret-change-me-32bytes!";
const RUN = newId().toLowerCase();
const T = (...ps: string[]): Grant[] => ps.map((permission) => ({ permission, scope: "WORKSPACE" }));
const S = (...ps: string[]): Grant[] => ps.map((permission) => ({ permission, scope: "SELF" }));
const EMPLOYEE = [...T("project.read", "task.read", "task.create", "ai.use", "home.read"), ...S("task.edit", "task.assign")];
const mk = (name: string, grants: Grant[]): Principal => ({ type: "user", id: `${name}-${RUN}`, teamIds: [], departmentId: null, grants });
const minh = mk("minh", [...EMPLOYEE, ...T("task.edit", "task.assign", "ai.agent.manage")]);
const lan = mk("lan", EMPLOYEE);
const huy = mk("huy", EMPLOYEE);
const people: Record<string, Principal> = { [minh.id]: minh, [lan.id]: lan, [huy.id]: huy };
const homeModule: Principal = { type: "service", id: "home", teamIds: [], departmentId: null, grants: [{ permission: "run.quick_action", scope: "PLATFORM" }] };

let script: string[] = [];
const ai = { request: async () => ({ text: script.shift() ?? "The draft.", ran: { model: "fake-1", inputTokens: 10, outputTokens: 10 } }) } as unknown as ServiceClient;

let work: INestApplication;
let home: INestApplication;
let workPool: pg.Pool;
let homePool: pg.Pool;
const urls: Record<string, string> = {};

async function call(svc: "work" | "home", p: Principal, method: string, path: string, body?: unknown) {
  const res = await fetch(`${urls[svc]}${path}`, {
    method,
    headers: { "content-type": "application/json", [PRINCIPAL_HEADER]: await signInternalToken({ principal: p, requestId: newId() }, SECRET) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const t = await res.text();
  return { status: res.status, body: t ? JSON.parse(t) : null };
}

/** The run once it stops moving (a server run is driven in the background). */
async function settled(taskId: string, not: string[] = ["queued", "running"]) {
  for (let i = 0; i < 200; i++) {
    const run = (await call("work", minh, "GET", `/tasks/${taskId}/runs`)).body.runs[0];
    if (run && !not.includes(run.status)) return run;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("run did not settle");
}

/** The run's events of one type, as home's consumer would get them. */
async function events(runId: string, type: string): Promise<EventEnvelope[]> {
  return (await workPool.query<{ payload: EventEnvelope }>("SELECT payload FROM outbox WHERE aggregateid = $1 AND type = $2 ORDER BY created_at", [runId, type])).rows.map(
    (r) => r.payload,
  );
}
const toHome = async (list: EventEnvelope[]) => {
  for (const e of list) await runWithContext({ actorId: "test", requestId: newId() }, () => withTransaction(homePool, (c) => project(e, c)));
};
const notes = async (p: Principal, refId: string) =>
  (
    await homePool.query<{ grp: string; kind: string; read_at: Date | null; url: string }>("SELECT grp, kind, read_at, url FROM notifications WHERE user_id = $1 AND ref_id = $2", [
      p.id,
      refId,
    ])
  ).rows;

const sent: { endpoint: string; payload: string }[] = [];
const sender = {
  send: async (s: { endpoint: string }, payload: string) => {
    sent.push({ endpoint: s.endpoint, payload });
    return { statusCode: 201 };
  },
};
const asked: string[] = [];
const quick: QuickLoader = async (userId, ref) => {
  asked.push(userId);
  return (await call("work", homeModule, "POST", "/internal/quick-actions", { userId, ...ref })).body;
};
type Payload = { title: string; body: string; url: string; actions?: { action: string; title: string; token: string }[]; done?: string };
// Only the pushes about this run: with the test server running on the same database (as in CI), its own projection
// of the task's other events (assigned…) queues pushes for the same people.
const pushed = (p: Principal, runId: string) =>
  sent
    .filter((s) => s.endpoint === `https://push.example.com/${p.id}`)
    .map((s) => JSON.parse(s.payload) as Payload)
    .filter((x) => x.url === `/app/chat/ask/${runId}`);
const mint = async (p: Principal, ref: Record<string, string>) =>
  (await call("work", homeModule, "POST", "/internal/quick-actions", { userId: p.id, ...ref })).body as {
    detail: string;
    actions: { action: string; label?: string; token: string }[];
  };
const redeem = (p: Principal, token: string) => call("work", p, "POST", "/quick-actions/redeem", { token });

/** A task of minh's, assigned to lan, on a workflow that drafts and then waits for approval (or as given). */
async function waitingRun(
  steps: Record<string, unknown>[] = [
    { title: "Draft", kind: "ai", prompt: "{{task}}" },
    { title: "Sign off", kind: "approval" },
  ],
  status = "waiting_approval",
) {
  const wf = (await call("work", minh, "POST", "/workflows", { name: `Quick ${newId()}`, steps })).body;
  expect(wf.id, JSON.stringify(wf)).toBeTruthy();
  const task = (await call("work", minh, "POST", "/tasks", { title: "Quarterly letter", assigneeId: lan.id })).body;
  await call("work", minh, "PUT", `/tasks/${task.id}/workflow`, { workflowId: wf.id });
  expect((await call("work", minh, "POST", `/tasks/${task.id}/runs`)).status).toBe(201);
  const run = await settled(task.id);
  expect(run.status, run.error).toBe(status);
  return { task, run };
}

beforeAll(async () => {
  for (const [db, dir] of [
    ["home", "../../migrations/home"],
    ["work", "../../migrations/work"],
  ] as const)
    await migrate("postgres://workspace_owner:owner_pw@localhost:5432/workspace_test", fileURLToPath(new URL(dir, import.meta.url)), db);
  homePool = new pg.Pool({ connectionString: "postgres://workspace_home:app_pw@localhost:5432/workspace_test", max: 5 });
  workPool = new pg.Pool({ connectionString: "postgres://workspace_work:app_pw@localhost:5432/workspace_test", max: 5 });
  const storage = new S3Storage({
    endpoint: "http://localhost:8333",
    region: "auto",
    bucket: "workspace-files",
    accessKeyId: "workspace_dev_key",
    secretAccessKey: "workspace_dev_secret",
  });
  work = await createWorkApp({ pool: workPool, storage, internalSecret: SECRET, ai, resolvePrincipal: async (id) => people[id] ?? Promise.reject(new Error("not a member")) });
  await work.listen(0);
  urls.work = (await work.getUrl()).replace("[::1]", "127.0.0.1");
  home = await createHomeApp({ pool: homePool, ai: null, internalSecret: SECRET });
  await home.listen(0);
  urls.home = (await home.getUrl()).replace("[::1]", "127.0.0.1");
  // Everyone has push on with one device; only lan lets notifications carry buttons.
  const keys = { p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString("base64url"), auth: Buffer.alloc(16, 9).toString("base64url") };
  for (const p of [minh, lan, huy]) {
    expect((await call("home", p, "GET", "/prefs")).body).toMatchObject({ pushEnabled: true, quickActions: false });
    await homePool.query("INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES ($1,$2,$3,$4)", [
      p.id,
      `https://push.example.com/${p.id}`,
      keys.p256dh,
      keys.auth,
    ]);
  }
  expect((await call("home", lan, "PUT", "/prefs", { quickActions: true })).body).toMatchObject({ quickActions: true });
}, 60_000);

afterAll(async () => {
  await homePool?.query("DELETE FROM push_subscriptions WHERE endpoint LIKE $1", [`https://push.example.com/%-${RUN}`]);
  await work?.close();
  await home?.close();
  await workPool?.end();
  await homePool?.end();
});

describe("a run that waits for approval", () => {
  it("tells the people who can approve, once; the push has buttons only for who allows them; acting settles it for everyone", async () => {
    const { task, run } = await waitingRun();
    const [waiting] = await events(run.id, "work.run.waiting.v1");
    const waitId = run.steps[1].waitId as string;
    expect(waitId).toBeTruthy();
    // "Anyone who may edit the task": of the people on it, the two who may. Nobody else hears of it.
    expect(waiting!.payload).toMatchObject({ waitId, step: "Sign off", title: "Quarterly letter" });
    expect([...(waiting!.payload.recipientIds as string[])].sort()).toEqual([lan.id, minh.id].sort());
    await toHome([waiting!]);
    for (const p of [minh, lan]) expect(await notes(p, waitId)).toEqual([{ grp: "action", kind: "task.agent_approval", read_at: null, url: `/app/chat/ask/${run.id}` }]);
    expect(await notes(huy, waitId)).toEqual([]);

    sent.length = 0;
    asked.length = 0;
    await sendInstantPushes(homePool, sender, 500, quick);
    // minh did not ask for buttons: the plain push, which says nothing of the task; the work module is not even asked.
    expect(pushed(minh, run.id)).toHaveLength(1);
    expect(pushed(minh, run.id)[0]!.actions).toBeUndefined();
    expect(JSON.stringify(pushed(minh, run.id)[0])).not.toContain(task.code);
    expect(asked).toEqual([lan.id]);
    const push = pushed(lan, run.id)[0]!;
    expect(push.url).toBe(`/app/chat/ask/${run.id}`);
    expect(push.body).toBe(`${task.code} · Sign off`);
    expect(push.actions!.map((a) => [a.action, !!a.token])).toEqual([
      ["quick:0", true],
      ["open", false],
    ]);
    expect(push.done).toBeTruthy();
    const token = push.actions![0]!.token;
    // The token is nowhere but in that payload: not in the event, and only its hash in the database.
    expect(JSON.stringify(waiting)).not.toContain("wqa_");
    expect((await workPool.query("SELECT 1 FROM agent_quick_actions WHERE token_hash = $1", [token])).rowCount).toBe(0);

    // Someone else's session with lan's token: refused, and the token is still lan's to use.
    expect((await redeem(huy, token)).status).toBe(404);
    expect((await redeem(minh, token)).status).toBe(404);
    // A key or a service is not a person pressing a button.
    expect((await redeem({ ...lan, type: "service" }, token)).status).toBe(404);
    expect((await redeem(lan, "wqa_not-a-token-anyone-made")).status).toBe(404);
    expect((await settled(task.id)).status).toBe("waiting_approval");

    const ok = await redeem(lan, token);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, action: "approve", runId: run.id });
    const after = await settled(task.id, ["queued", "running", "waiting_approval"]);
    expect(after.status).toBe("done");
    expect(after.steps[1].history.at(-1)).toMatchObject({ kind: "approved", by: lan.id });
    // Used once.
    expect((await redeem(lan, token)).status).toBe(404);

    // Approved by lan: it no longer waits for minh either.
    const decided = await events(run.id, "work.run.decided.v1");
    expect(decided.map((e) => e.payload)).toMatchObject([{ waitId, outcome: "approved" }]);
    await toHome(decided);
    for (const p of [minh, lan]) expect(await notes(p, waitId)).toMatchObject([{ grp: "update", read_at: expect.any(Date) }]);
  }, 60_000);

  it("a token is for one wait: work sent back and waiting again is not approved by an old notification", async () => {
    script = ["First draft.", "Second draft."];
    const { task, run } = await waitingRun();
    const first = run.steps[1].waitId as string;
    const old = (await mint(lan, { runId: run.id, waitId: first })).actions[0]!.token;
    expect((await call("work", minh, "POST", `/runs/${run.id}/rework`, { note: "Shorter." })).status).toBe(201);
    const again = await settled(task.id);
    expect(again.status).toBe("waiting_approval");
    const second = again.steps[1].waitId as string;
    expect(second).not.toBe(first);
    expect((await redeem(lan, old)).status).toBe(409);
    expect((await settled(task.id)).status).toBe("waiting_approval");
    // The first wait closed as sent back, a second one opened: two notices in all, one still open.
    expect((await events(run.id, "work.run.decided.v1")).map((e) => e.payload.outcome)).toEqual(["sent_back"]);
    expect(await events(run.id, "work.run.waiting.v1")).toHaveLength(2);
    // No buttons for a wait that is over, for someone who cannot approve, or for a run that does not wait.
    expect((await mint(lan, { runId: run.id, waitId: first })).actions).toEqual([]);
    expect((await mint(huy, { runId: run.id, waitId: second })).actions).toEqual([]);
    // Only the home module asks for buttons.
    expect((await call("work", minh, "POST", "/internal/quick-actions", { userId: lan.id, runId: run.id, waitId: second })).status).toBe(403);

    // A new set of buttons replaces the one before it; an hour later a button is only a way into the app.
    const a = (await mint(lan, { runId: run.id, waitId: second })).actions[0]!.token;
    const b = (await mint(lan, { runId: run.id, waitId: second })).actions[0]!.token;
    expect((await redeem(lan, a)).status).toBe(404);
    await workPool.query("UPDATE agent_quick_actions SET expires_at = now() - interval '1 minute' WHERE user_id = $1 AND wait_id = $2", [lan.id, second]);
    expect((await redeem(lan, b)).status).toBe(404);
    expect((await settled(task.id)).status).toBe("waiting_approval");

    // Stopped: the wait closes for everyone, and a push about it that was not sent yet never goes out.
    const [, waiting] = await events(run.id, "work.run.waiting.v1");
    await toHome([waiting!]);
    expect((await homePool.query("SELECT 1 FROM push_outbox WHERE ref->>'waitId' = $1", [second])).rowCount).toBe(2);
    expect((await call("work", minh, "POST", `/runs/${run.id}/cancel`)).status).toBe(201);
    const decided = await events(run.id, "work.run.decided.v1");
    expect(decided.map((e) => e.payload.outcome)).toEqual(["sent_back", "cancelled"]);
    await toHome(decided);
    expect((await homePool.query("SELECT 1 FROM push_outbox WHERE ref->>'waitId' = $1", [second])).rowCount).toBe(0);
    expect(await notes(lan, second)).toMatchObject([{ grp: "update" }]);
  }, 60_000);

  it("a step that names its approver tells that person only", async () => {
    const { run } = await waitingRun([
      { title: "Draft", kind: "ai", prompt: "{{task}}" },
      { title: "Legal", kind: "approval", approver: "person", approverId: minh.id },
    ]);
    const [waiting] = await events(run.id, "work.run.waiting.v1");
    expect(waiting!.payload.recipientIds).toEqual([minh.id]);
    const waitId = run.steps[1].waitId as string;
    // lan may edit the task, but this approval is not hers: no notice, no button.
    expect((await mint(lan, { runId: run.id, waitId })).actions).toEqual([]);
    const m = await mint(minh, { runId: run.id, waitId });
    expect(m.actions.map((a) => a.action)).toEqual(["approve"]);
    expect((await redeem(minh, m.actions[0]!.token)).status).toBe(200);
  }, 60_000);
});

describe("a run that asks", () => {
  const ask = (questions: unknown[]) => `\`\`\`workspace-ask\n${JSON.stringify({ questions })}\n\`\`\``;

  it("an either/or question is answered from the notification; anything longer opens the app", async () => {
    script = [ask([{ text: "Which market first?", options: ["Vietnam", "Singapore"] }]), "Vietnam it is."];
    const { task, run } = await waitingRun([{ title: "Plan", kind: "ai", prompt: "{{task}}" }], "waiting_input");
    const [asking] = await events(run.id, "work.run.asked.v1");
    const questionId = asking!.payload.questionId as string;
    await toHome([asking!]);
    sent.length = 0;
    await sendInstantPushes(homePool, sender, 500, quick);
    const push = pushed(lan, run.id)[0]!;
    expect(push.body).toBe(`${task.code} · Which market first?`);
    expect(push.actions!.map((a) => a.title)).toEqual(["Vietnam", "Singapore"]);
    expect(pushed(minh, run.id)[0]!.actions).toBeUndefined();
    // huy is not on the task: no buttons for him, whatever he holds.
    expect((await mint(huy, { runId: run.id, questionId })).actions).toEqual([]);

    expect((await redeem(lan, push.actions![1]!.token)).status).toBe(200);
    const after = await settled(task.id, ["queued", "running", "waiting_input"]);
    expect(after.status).toBe("done");
    expect(after.asks[0]).toMatchObject({ outcome: "answered", answeredBy: lan.id });
    expect(Object.values(after.asks[0].answers)).toEqual(["Singapore"]);
    // The other button of the same notification answers nothing any more.
    expect((await redeem(lan, push.actions![0]!.token)).status).toBe(409);

    script = [ask([{ text: "Which market first?", options: ["Vietnam", "Singapore", "Thailand"] }])];
    const three = await waitingRun([{ title: "Plan", kind: "ai", prompt: "{{task}}" }], "waiting_input");
    const q3 = (await events(three.run.id, "work.run.asked.v1"))[0]!.payload.questionId as string;
    expect((await mint(lan, { runId: three.run.id, questionId: q3 })).actions).toEqual([]);
    script = [ask([{ text: "Who signs?" }])];
    const free = await waitingRun([{ title: "Plan", kind: "ai", prompt: "{{task}}" }], "waiting_input");
    const qf = (await events(free.run.id, "work.run.asked.v1"))[0]!.payload.questionId as string;
    expect((await mint(lan, { runId: free.run.id, questionId: qf })).actions).toEqual([]);
  }, 60_000);
});
