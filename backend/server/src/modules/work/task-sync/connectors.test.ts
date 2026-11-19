import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONNECTORS } from "./connectors/index.js";
import { clickupStatus } from "./connectors/clickup.js";
import { jiraSite, jiraStatus } from "./connectors/jira.js";
import { linearStatus } from "./connectors/linear.js";
import { statusFromName, SyncApiError, type Fetcher } from "./types.js";

const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", `${name}.json`), "utf8")) as Record<string, unknown>;

/** Answers recorded payloads by URL; every request is kept for assertions. */
function recorded(routes: [RegExp, unknown | ((url: string, init?: RequestInit) => unknown)][]) {
  const calls: { url: string; init?: RequestInit | undefined }[] = [];
  const f: Fetcher = async (url, init) => {
    calls.push({ url, init });
    const hit = routes.find(([re]) => re.test(url));
    if (!hit) return new Response("not found", { status: 404 });
    const body = typeof hit[1] === "function" ? (hit[1] as (u: string, i?: RequestInit) => unknown)(url, init) : hit[1];
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { f, calls };
}

describe("task sync connectors (recorded payloads)", () => {
  it("Asana: projects across workspaces, tasks paged, status from the completed flag and the board section", async () => {
    const a = fixture("asana");
    const { f, calls } = recorded([
      [/\/workspaces/, a.workspaces],
      [/\/projects\?/, a.projects],
      [/\/tasks\?.*offset=abc/, a.tasks_page2],
      [/\/tasks\?/, a.tasks_page1],
    ]);
    const cred = { token: "1/secret" };
    expect(await CONNECTORS.asana.listProjects(cred, f)).toEqual([
      { id: "1201", name: "Website relaunch" },
      { id: "1202", name: "Q4 campaign" },
    ]);
    const since = new Date("2026-11-01T00:00:00Z");
    const tasks = await CONNECTORS.asana.fetchTasks(cred, ["1201"], since, f);
    expect(tasks.map((t) => [t.id, t.status, t.key, t.assigneeEmail])).toEqual([
      ["9001", "done", null, "Lily@Brightline.test"],
      ["9002", "in_progress", null, "nobody@elsewhere.test"],
      ["9003", "review", null, null],
    ]);
    expect(tasks[0]).toMatchObject({ completedAt: "2026-11-03T15:20:00.000Z", dueAt: "2026-11-04T17:00:00.000Z", url: "https://app.asana.com/0/1201/9001" });
    expect(tasks[1]!.dueAt).toBe("2026-11-12T16:00:00.000Z");
    const taskCall = calls.find((c) => c.url.includes("/tasks?"))!;
    expect(taskCall.url).toContain("modified_since=2026-11-01T00%3A00%3A00.000Z");
    expect((taskCall.init?.headers as Record<string, string>).Authorization).toBe("Bearer 1/secret");
  });

  it("ClickUp: lists in and out of folders; custom ids as keys, else the task id; closed is done", async () => {
    const c = fixture("clickup");
    const { f, calls } = recorded([
      [/\/team$/, c.team],
      [/\/team\/t1\/space/, c.spaces],
      [/\/space\/s1\/folder/, c.folders],
      [/\/space\/s1\/list/, c.lists],
      [/\/list\/L1\/task/, c.tasks],
    ]);
    expect(await CONNECTORS.clickup.listProjects({ token: "pk_x" }, f)).toEqual([
      { id: "L1", name: "Product › Backlog" },
      { id: "L2", name: "Product › Mobile › Sprint 12" },
    ]);
    const tasks = await CONNECTORS.clickup.fetchTasks({ token: "pk_x" }, ["L1"], new Date(1793000000000), f);
    expect(tasks.map((t) => [t.key, t.status])).toEqual([
      ["#86B1X2Y3Z", "done"],
      ["DEV-42", "review"],
    ]);
    expect(tasks[0]).toMatchObject({ completedAt: new Date(1793990000000).toISOString(), startedAt: new Date(1793600000000).toISOString(), assigneeEmail: "lily@brightline.test" });
    expect(calls.at(-1)!.url).toContain("date_updated_gt=1793000000000");
    expect((calls[0]!.init?.headers as Record<string, string>).Authorization).toBe("pk_x");
  });

  it("Linear: teams, identifiers as keys, state types mapped, cursor sent as the filter", async () => {
    const l = fixture("linear");
    const { f, calls } = recorded([[/linear\.app\/graphql/, (_u: string, init?: RequestInit) => (String(init?.body).includes("issues(") ? l.issues : l.teams)]]);
    expect(await CONNECTORS.linear.listProjects({ token: "lin_api_x" }, f)).toEqual([{ id: "team-eng", name: "Engineering", key: "ENG" }]);
    const tasks = await CONNECTORS.linear.fetchTasks({ token: "lin_api_x" }, ["team-eng"], new Date("2026-11-04T00:00:00Z"), f);
    expect(tasks.map((t) => [t.key, t.status])).toEqual([
      ["ENG-123", "done"],
      ["ENG-124", "review"],
      ["ENG-125", "cancelled"],
    ]);
    expect(tasks[0]).toMatchObject({ startedAt: "2026-11-02T09:00:00.000Z", completedAt: "2026-11-05T12:00:00.000Z", dueAt: "2026-11-06T17:00:00.000Z" });
    const vars = JSON.parse(String(calls.at(-1)!.init?.body)).variables;
    expect(vars).toMatchObject({ teams: ["team-eng"], since: "2026-11-04T00:00:00.000Z" });
  });

  it("Jira Cloud: site normalised, basic auth, JQL with the cursor, categories mapped", async () => {
    const j = fixture("jira");
    const { f, calls } = recorded([
      [/project\/search/, j.projects],
      [/search\/jql/, j.search],
    ]);
    const cred = { token: "atl-token", site: "acme.atlassian.net/jira/software/projects/OPS/boards/1", email: "admin@acme.test" };
    expect(await CONNECTORS.jira.listProjects(cred, f)).toEqual([{ id: "10001", name: "Operations", key: "OPS" }]);
    const tasks = await CONNECTORS.jira.fetchTasks(cred, ["10001"], new Date("2026-11-03T10:00:00Z"), f);
    expect(tasks.map((t) => [t.key, t.status, t.url])).toEqual([
      ["OPS-7", "done", "https://acme.atlassian.net/browse/OPS-7"],
      ["OPS-8", "in_progress", "https://acme.atlassian.net/browse/OPS-8"],
      ["OPS-9", "cancelled", "https://acme.atlassian.net/browse/OPS-9"],
    ]);
    const search = calls.find((c) => c.url.endsWith("/search/jql"))!;
    expect(JSON.parse(String(search.init?.body)).jql).toBe('project in (10001) AND updated >= "2026-11-03 09:59" ORDER BY updated ASC');
    expect((search.init?.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from("admin@acme.test:atl-token").toString("base64")}`);
  });

  it("turns a refused token into a message an admin can act on", async () => {
    const f: Fetcher = async () => new Response("{}", { status: 401 });
    await expect(CONNECTORS.linear.listProjects({ token: "bad" }, f)).rejects.toThrow(/Linear refused the token/);
    await expect(CONNECTORS.jira.listProjects({ token: "t", site: "acme.atlassian.net" }, f)).rejects.toBeInstanceOf(SyncApiError);
    expect(() => jiraSite("")).toThrow(/site address/);
    expect(() => jiraSite("http://acme.atlassian.net")).toThrow(/https/);
  });
});

describe("status mapping", () => {
  it("reads custom status names", () => {
    expect(statusFromName("Code review", "in_progress")).toBe("review");
    expect(statusFromName("Doing", "todo")).toBe("in_progress");
    expect(statusFromName("Won't do", "done")).toBe("cancelled");
    expect(statusFromName("Backlog", "todo")).toBe("todo");
    expect(clickupStatus({ status: "to do", type: "open" })).toBe("todo");
    expect(clickupStatus({ status: "blocked", type: "custom" })).toBe("in_progress");
    expect(linearStatus({ type: "triage", name: "Triage" })).toBe("todo");
    expect(jiraStatus({ name: "Ready for QA", statusCategory: { key: "indeterminate" } })).toBe("review");
    expect(jiraStatus({ name: "Backlog", statusCategory: { key: "new" } })).toBe("todo");
  });
});
