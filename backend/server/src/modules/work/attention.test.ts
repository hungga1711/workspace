import { describe, expect, it } from "vitest";
import type { Grant, Principal } from "@workspace/shared";
import { hubItems, runItems, syncItems, triggerItems, type FireLite, type RunLite, type RunnerLite, type SyncLite } from "./attention.js";

const now = Date.parse("2026-11-13T10:00:00Z");
const ago = (min: number) => new Date(now - min * 60_000);
const grants = (scope: Grant["scope"], ...ps: string[]): Grant[] => ps.map((permission) => ({ permission, scope }));
const admin: Principal = { type: "user", id: "minh", teamIds: [], departmentId: null, grants: grants("WORKSPACE", "task.read", "ai.agent.manage") };
// Manages agents, but reads only their own tasks.
const narrow: Principal = { type: "user", id: "lan", teamIds: [], departmentId: null, grants: [...grants("SELF", "task.read"), ...grants("WORKSPACE", "ai.agent.manage")] };
const run = (o: Partial<RunLite>): RunLite => ({
  id: "r1",
  workflow_name: "Launch post",
  status: "failed",
  error: "the check did not pass",
  started_by: "huy",
  updated_at: ago(30),
  finished_at: ago(30),
  host: "person",
  container: false,
  code: "T-1",
  title: "Write the post",
  owner_id: "huy",
  assignee_id: "huy",
  team_id: null,
  project_id: "p1",
  ...o,
});
const runner = (o: Partial<RunnerLite>): RunnerLite => ({ user_id: "huy", shared: false, docker: false, online: true, ...o });

describe("agent runs that need an admin", () => {
  it("a failed run is listed with its reason, its task and who started it", () => {
    expect(runItems(admin, [run({})], [], now)).toEqual([
      {
        id: "work.run.failed:r1",
        kind: "work.run.failed",
        severity: "broken",
        since: ago(30).toISOString(),
        name: "Launch post",
        detail: "the check did not pass",
        ownerId: "huy",
        taskCode: "T-1",
        taskTitle: "Write the post",
      },
    ]);
  });
  it("a run on a task the reader cannot open is never listed, not even as a count", () => {
    expect(runItems(narrow, [run({})], [], now)).toEqual([]);
    expect(runItems(narrow, [run({ assignee_id: "lan" })], [], now)).toHaveLength(1);
  });
  it("waiting for a person only counts after a day", () => {
    expect(runItems(admin, [run({ status: "waiting_approval", updated_at: ago(60) })], [], now)).toEqual([]);
    expect(
      runItems(admin, [run({ status: "waiting_approval", updated_at: ago(25 * 60) }), run({ id: "r2", status: "waiting_input", updated_at: ago(30 * 60) })], [], now),
    ).toMatchObject([
      { kind: "work.run.approval", severity: "warning" },
      { kind: "work.run.question", severity: "warning" },
    ]);
  });
  it("a queued run is stuck when no computer that could take it is connected", () => {
    const queued = run({ status: "queued", updated_at: ago(20), error: null });
    expect(runItems(admin, [queued], [runner({})], now)).toEqual([]);
    // Someone else's computer, an offline one, or one without Docker for a container run does not count.
    expect(runItems(admin, [queued], [runner({ user_id: "lan" }), runner({ online: false })], now)).toMatchObject([{ kind: "work.run.noComputer" }]);
    expect(runItems(admin, [{ ...queued, container: true }], [runner({})], now)).toMatchObject([{ kind: "work.run.noComputer" }]);
    expect(runItems(admin, [{ ...queued, host: "company" }], [runner({})], now)).toMatchObject([{ kind: "work.run.noCompanyComputer" }]);
    expect(runItems(admin, [{ ...queued, host: "company" }], [runner({ user_id: "ops", shared: true })], now)).toEqual([]);
    // Just queued: it is starting, not stuck.
    expect(runItems(admin, [{ ...queued, updated_at: ago(2) }], [], now)).toEqual([]);
  });
});

describe("task sync that needs an admin", () => {
  const sync = (o: Partial<SyncLite>): SyncLite => ({
    id: "s1",
    name: "Linear",
    created_by: "minh",
    created_at: ago(600),
    last_run_at: ago(10),
    last_ok_at: ago(10),
    last_error: null,
    ...o,
  });
  it("a connection that ran lately without an error is not listed", () => {
    expect(syncItems([sync({})], now)).toEqual([]);
  });
  it("a failing one is broken since it last worked", () => {
    expect(syncItems([sync({ last_error: "401 Unauthorized", last_ok_at: ago(300) })], now)).toMatchObject([
      { kind: "work.sync.failed", severity: "broken", detail: "401 Unauthorized", since: ago(300).toISOString() },
    ]);
  });
  it("one that has gone quiet, or never ran, is unknown, never healthy", () => {
    expect(syncItems([sync({ last_run_at: ago(180), last_ok_at: ago(180) })], now)).toMatchObject([
      { kind: "work.sync.silent", severity: "unknown", since: ago(180).toISOString() },
    ]);
    expect(syncItems([sync({ last_run_at: null, last_ok_at: null })], now)).toMatchObject([{ kind: "work.sync.silent", severity: "unknown", since: null }]);
    // Connected a moment ago: its first run is still to come.
    expect(syncItems([sync({ created_at: ago(5), last_run_at: null, last_ok_at: null })], now)).toEqual([]);
  });
});

describe("the integrations hub and triggers", () => {
  it("lists a connection whose last read failed, by the tool's name and account", () => {
    const row = { id: "c1", provider: "github", account: "acme", created_by: "minh", last_ok_at: new Date("2026-11-12T08:00:00Z"), last_error: "401 Bad credentials" };
    expect(hubItems([row, { ...row, id: "c2", last_error: null }], () => "GitHub")).toEqual([
      {
        id: "work.hub.failed:c1",
        kind: "work.hub.failed",
        severity: "broken",
        since: "2026-11-12T08:00:00.000Z",
        name: "GitHub · acme",
        ownerId: "minh",
        detail: "401 Bad credentials",
      },
    ]);
  });

  it("lists a workflow only when its latest fires were all refused", () => {
    const fire = (workflow_id: string, status: FireLite["status"], min: number, reason: string | null = null): FireLite => ({
      workflow_id,
      name: `WF ${workflow_id}`,
      created_by: "minh",
      status,
      reason,
      created_at: new Date(Date.parse("2026-11-13T09:00:00Z") - min * 60_000),
    });
    const items = triggerItems([
      // Three refusals in a row: not working.
      fire("a", "refused", 1, "the person it runs as may no longer edit the task"),
      fire("a", "refused", 2),
      fire("a", "refused", 3),
      // A start among them: working, with reasons not to start sometimes.
      fire("b", "refused", 1),
      fire("b", "started", 2),
      fire("b", "refused", 3),
      // Too few to say.
      fire("c", "refused", 1),
    ]);
    expect(items).toEqual([
      {
        id: "work.trigger.refused:a",
        kind: "work.trigger.refused",
        severity: "warning",
        since: "2026-11-13T08:57:00.000Z",
        name: "WF a",
        ownerId: "minh",
        workflowId: "a",
        detail: "the person it runs as may no longer edit the task",
      },
    ]);
  });
});
