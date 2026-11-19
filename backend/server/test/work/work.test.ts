import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import type { INestApplication } from "@nestjs/common";
import pg from "pg";
import { migrate, signInternalToken, PRINCIPAL_HEADER, S3Storage } from "@workspace/service-kit";
import { newId, runWithContext, withTransaction, type Grant, type Principal } from "@workspace/shared";
import { createWorkApp } from "../../src/modules/work/app.js";
import { sweepPendingFiles } from "../../src/modules/work/files.js";
import { resetTestDatabase } from "../test-db.js";

const SECRET = "dev-internal-secret-change-me-32bytes!";
const T = (...ps: string[]): Grant[] => ps.map((permission) => ({ permission, scope: "WORKSPACE" }));
const S = (...ps: string[]): Grant[] => ps.map((permission) => ({ permission, scope: "SELF" }));
const EMPLOYEE = [
  ...T("project.read", "project.create", "task.read", "task.create", "document.read", "document.create", "file.upload", "file.read"),
  ...S("task.edit", "task.assign", "document.edit", "document.share", "calendar.read", "calendar.edit"),
];
const ADMIN = [...EMPLOYEE, ...T("task.edit", "task.assign", "task.delete", "project.edit", "workspace.configure", "approval.decide")];
const mk = (id: string, grants: Grant[], type: Principal["type"] = "user"): Principal => ({ type, id, teamIds: [], departmentId: null, grants });
const minh = mk("minh", ADMIN);
const lan = mk("lan", EMPLOYEE);
const huy = mk("huy", EMPLOYEE);

const storage = new S3Storage({
  endpoint: "http://localhost:8333",
  region: "auto",
  bucket: "workspace-files",
  accessKeyId: "workspace_dev_key",
  secretAccessKey: "workspace_dev_secret",
});
let app: INestApplication;
let base: string;
let pool: pg.Pool;

async function call(p: Principal, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", [PRINCIPAL_HEADER]: await signInternalToken({ principal: p, requestId: newId() }, SECRET), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const t = await res.text();
  return { status: res.status, body: t ? JSON.parse(t) : null };
}

beforeAll(async () => {
  await migrate("postgres://workspace_owner:owner_pw@localhost:5432/workspace_test", fileURLToPath(new URL("../../migrations/work", import.meta.url)), "work");
  // Each suite starts from an empty installation: counts and codes below assume only its own rows.
  await resetTestDatabase();
  await storage.ensureBucket();
  pool = new pg.Pool({ connectionString: "postgres://workspace_work:app_pw@localhost:5432/workspace_test", max: 10 });
  app = await createWorkApp({ pool, storage, internalSecret: SECRET });
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "127.0.0.1");
});

afterAll(async () => {
  await app?.close();
});

describe("tasks", () => {
  let project: { id: string; code: string };
  let task: any;

  it("creates a project with default Kanban columns and coded tasks", async () => {
    project = (await call(minh, "POST", "/projects", { name: "Launch Alpha" })).body;
    expect(project.code).toMatch(/^P-\d{3,}$/);
    task = (await call(lan, "POST", "/tasks", { title: "Write proposal", projectId: project.id, dueAt: "2026-10-20T10:00:00+07:00" })).body;
    expect(task.code).toMatch(/^T-\d{3,}$/);
    expect(task.ownerId).toBe("lan");
    const board = (await call(lan, "GET", `/projects/${project.id}/board`)).body;
    // Columns stand for the four statuses; their names follow the creator's language (English when none is sent).
    expect(board.columns.map((c: { status: string }) => c.status)).toEqual(["todo", "in_progress", "review", "done"]);
    expect(board.columns.map((c: { name: string }) => c.name)).toEqual(["To do", "In progress", "Review", "Done"]);
    const vi = (await call(minh, "POST", "/projects", { name: "Ra mắt" }, { "x-locale": "vi" })).body;
    const viBoard = (await call(minh, "GET", `/projects/${vi.id}/board`)).body;
    expect(viBoard.columns.map((c: { name: string }) => c.name)).toEqual(["Cần làm", "Đang làm", "Chờ duyệt", "Xong"]);
    expect(board.columns[0].tasks.map((t: { id: string }) => t.id)).toEqual([task.id]);
    // "Việc của tôi" also lists my own to-dos that nobody is assigned to yet.
    const todo = (await call(huy, "POST", "/tasks", { title: "Gọi lại khách" })).body;
    expect((await call(huy, "GET", "/tasks")).body.tasks.map((t: { id: string }) => t.id)).toContain(todo.id);
  });

  it("boards filter on the server and page each column, so big projects stay fast", async () => {
    const big = (await call(minh, "POST", "/projects", { name: "Big board" })).body;
    for (let i = 0; i < 7; i++) await call(minh, "POST", "/tasks", { title: `Thẻ ${i}`, projectId: big.id, assigneeId: i % 2 ? "lan" : null, labels: i < 2 ? ["api"] : [] });
    const url = (q: string) => `/projects/${big.id}/board?${q}`;
    const todo = (b: { columns: { id: string; count: number; total: number; tasks: { title: string }[] }[] }) => b.columns[0]!;
    const page1 = todo((await call(minh, "GET", url("limit=3"))).body);
    expect(page1).toMatchObject({ count: 7, total: 7 });
    expect(page1.tasks).toHaveLength(3);
    const first = (await call(minh, "GET", url(""))).body.columns[0].id;
    const more = (await call(minh, "GET", url(`limit=3&offset=3&column=${first}`))).body;
    expect(more.columns).toHaveLength(1);
    expect(more.columns[0].tasks.map((t: { title: string }) => t.title)).not.toContain(page1.tasks[0]!.title);
    expect(todo((await call(minh, "GET", url("assignee=lan"))).body)).toMatchObject({ count: 3, total: 7 });
    expect(todo((await call(minh, "GET", url("assignee=none"))).body).count).toBe(4);
    expect(todo((await call(minh, "GET", url("label=api"))).body).count).toBe(2);
    expect(todo((await call(minh, "GET", url("q=Thẻ%205"))).body).tasks.map((t) => t.title)).toEqual(["Thẻ 5"]);
    // At risk: a forecast past the due date, or due tomorrow and barely started.
    const soon = new Date(Date.now() + 86400_000).toISOString();
    const late = (await call(minh, "POST", "/tasks", { title: "Báo giá", projectId: big.id, dueAt: soon })).body;
    await call(minh, "POST", "/tasks", { title: "Gần xong", projectId: big.id, dueAt: soon });
    const nearly = todo((await call(minh, "GET", url("q=Gần"))).body).tasks[0] as unknown as { id: string };
    await call(minh, "POST", `/tasks/${nearly.id}/checkin`, { progress: 90 });
    await call(minh, "POST", `/tasks/${late.id}/checkin`, { progress: 10 });
    const risky = (await call(minh, "GET", url("due=risk"))).body.columns.flatMap((c: { tasks: { title: string; atRisk: boolean }[] }) => c.tasks);
    expect(risky.map((t: { title: string }) => t.title)).toEqual(["Báo giá"]);
    expect(risky[0].atRisk).toBe(true);
  });

  it("uses the workspace's sequential code format with a transactional counter", async () => {
    await runWithContext({ actorId: "test", requestId: newId() }, () =>
      withTransaction(pool, (c) =>
        c.query(`INSERT INTO workspace_settings (code_formats, version) VALUES ($1, 99) ON CONFLICT (singleton) DO UPDATE SET code_formats = EXCLUDED.code_formats`, [
          JSON.stringify({ task: "TASK-{yyyy}-{seq7}", project: "P-{id10}", document: "D-{id10}", employee: "EMP-{seq6}" }),
        ]),
      ),
    );
    const codes = await Promise.all(Array.from({ length: 10 }, () => call(lan, "POST", "/tasks", { title: "seq", projectId: project.id })));
    const nums = codes.map((r) => r.body.code as string).sort();
    expect(new Set(nums).size).toBe(10);
    expect(nums[0]).toMatch(new RegExp(`^TASK-${new Date().getUTCFullYear()}-\\d{7}$`));
  });

  it("lets owner and assignee edit, not other employees", async () => {
    expect((await call(huy, "PATCH", `/tasks/${task.id}`, { expectedVersion: task.version, title: "hijack" })).status).toBe(403);
    const assigned = (await call(lan, "PATCH", `/tasks/${task.id}`, { expectedVersion: task.version, assigneeId: "huy" })).body;
    const byAssignee = await call(huy, "PATCH", `/tasks/${task.id}`, { expectedVersion: assigned.version, description: "drafted" });
    expect(byAssignee.status).toBe(200);
    task = byAssignee.body;
  });

  it("rejects stale writes (optimistic concurrency)", async () => {
    const r = await call(lan, "PATCH", `/tasks/${task.id}`, { expectedVersion: task.version - 1, title: "stale" });
    expect(r.status).toBe(409);
    expect(r.body.currentVersion).toBe(task.version);
  });

  it("enforces WIP limits on Kanban moves and keeps rank order", async () => {
    const board = (await call(minh, "GET", `/projects/${project.id}/board`)).body;
    const review = board.columns[2];
    await call(minh, "PUT", `/projects/${project.id}/columns/${review.id}`, { wipLimit: 2 });
    const todo = board.columns[0].tasks as { id: string; version: number }[];
    const moved: any[] = [];
    for (const t of todo.slice(0, 2)) moved.push((await call(minh, "POST", `/tasks/${t.id}/move`, { columnId: review.id, expectedVersion: t.version })).body);
    const third = await call(minh, "POST", `/tasks/${todo[2]!.id}/move`, { columnId: review.id, expectedVersion: todo[2]!.version });
    expect(third.status).toBe(409);
    expect(third.body).toMatchObject({ error: "wip_limit", limit: 2 });
    expect(third.body.message).toMatch(/WIP limit/);
    // Reorder inside the column (not limited): move the second before the first.
    const re = await call(minh, "POST", `/tasks/${moved[1].id}/move`, { columnId: review.id, beforeId: moved[0].id, expectedVersion: moved[1].version });
    expect(re.status).toBe(201);
    const after = (await call(minh, "GET", `/projects/${project.id}/board`)).body.columns[2];
    expect(after.tasks.map((t: { id: string }) => t.id)).toEqual([moved[1].id, moved[0].id]);
    // Each column stands for a status: cards moved to Review are in review, and the history says so.
    expect(moved.map((t) => t.status)).toEqual(["review", "review"]);
    const items = (await call(minh, "GET", `/tasks/${moved[0].id}`)).body.activity as { action: string; changes: Record<string, unknown> }[];
    expect(items.some((a) => a.action === "moved" && a.changes.from === "todo" && a.changes.to === "review")).toBe(true);
  });

  it("columns stand for statuses: moves set the status, status changes move the card", async () => {
    const pr = (await call(minh, "POST", "/projects", { name: "Status columns" })).body;
    const board = async () =>
      (await call(minh, "GET", `/projects/${pr.id}/board`)).body.columns as { id: string; name: string; status: string; tasks: { id: string; status: string }[] }[];
    // Employees who do not lead the project may not change its columns.
    expect((await call(huy, "POST", `/projects/${pr.id}/columns`, { name: "Nope" })).status).toBe(403);
    // A new column says which status it stands for; without one, its name decides ("Chờ khách" reads as review).
    const added = await call(minh, "POST", `/projects/${pr.id}/columns`, { name: "Chờ khách" });
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ name: "Chờ khách", position: 4, status: "review" });
    const qa = (await call(minh, "POST", `/projects/${pr.id}/columns`, { name: "Lane X", status: "in_progress", afterId: (await board())[0]!.id })).body;
    expect(qa.status).toBe("in_progress");
    expect((await call(minh, "PUT", `/projects/${pr.id}/columns/${added.body.id}`, { name: "Chờ khách duyệt" })).status).toBe(200);
    expect((await call(huy, "PUT", `/projects/${pr.id}/columns/${added.body.id}`, { name: "x" })).status).toBe(403);
    expect((await call(minh, "PUT", `/projects/${pr.id}/columns/${added.body.id}`, { status: "cancelled" })).status).toBe(400);

    // "+" on a column: the task starts with that column's status.
    const inReview = (await call(minh, "POST", "/tasks", { title: "Gọi khách", projectId: pr.id, columnId: added.body.id })).body;
    expect(inReview).toMatchObject({ status: "review", columnId: added.body.id });
    // A task created with a status lands in that status's column (the leftmost one).
    const t = (await call(minh, "POST", "/tasks", { title: "Gửi báo giá", projectId: pr.id, status: "done" })).body;
    let cols = await board();
    const done = cols.find((c) => c.status === "done")!;
    expect(done.tasks.map((x) => x.id)).toEqual([t.id]);

    // Move to a column → its status (and completed_at goes away when leaving done).
    const moved = (await call(minh, "POST", `/tasks/${t.id}/move`, { columnId: qa.id, expectedVersion: t.version })).body;
    expect(moved).toMatchObject({ status: "in_progress", columnId: qa.id, completedAt: null });
    // A status change the column already stands for leaves the card where it is (two in-progress columns).
    const inProgress = cols.find((c) => c.status === "in_progress" && c.id !== qa.id)!;
    const stay = (await call(minh, "POST", `/tasks/${t.id}/move`, { status: "in_progress", expectedVersion: moved.version })).body;
    expect(stay.columnId).toBe(qa.id);
    // Changing the status in the task moves the card to that status's column.
    const reviewed = (await call(minh, "PATCH", `/tasks/${t.id}`, { expectedVersion: stay.version, status: "review" })).body;
    const firstReview = cols.find((c) => c.status === "review")!;
    expect(reviewed).toMatchObject({ status: "review", columnId: firstReview.id });
    expect(firstReview.id).not.toBe(inProgress.id);
    // Cancelled has no column: the card stays put, and dragging it back onto the board reopens it with that column.
    const cancelled = (await call(minh, "PATCH", `/tasks/${t.id}`, { expectedVersion: reviewed.version, status: "cancelled" })).body;
    expect(cancelled).toMatchObject({ status: "cancelled", columnId: firstReview.id });
    const revived = (await call(minh, "POST", `/tasks/${t.id}/move`, { columnId: done.id, expectedVersion: cancelled.version })).body;
    expect(revived.status).toBe("done");
    expect(revived.completedAt).toBeTruthy();

    // Changing what a column stands for re-statuses its cards (cancelled stay cancelled).
    expect((await call(minh, "PUT", `/projects/${pr.id}/columns/${added.body.id}`, { status: "in_progress" })).status).toBe(200);
    cols = await board();
    expect(cols.find((c) => c.id === added.body.id)!.tasks.find((x) => x.id === inReview.id)!.status).toBe("in_progress");

    // Reorder keeps statuses.
    const ids = [added.body.id, ...cols.map((c) => c.id).filter((x) => x !== added.body.id)];
    expect((await call(minh, "PUT", `/projects/${pr.id}/columns`, { ids })).status).toBe(200);
    expect((await board()).map((c) => c.id)).toEqual(ids);
    // Delete: cards go to the named column and take its status.
    expect((await call(minh, "DELETE", `/projects/${pr.id}/columns/${added.body.id}?moveTo=nope`)).status).toBe(400);
    const del = await call(minh, "DELETE", `/projects/${pr.id}/columns/${added.body.id}?moveTo=${done.id}`);
    expect(del.body).toMatchObject({ ok: true, movedTo: done.id });
    cols = await board();
    expect(cols.find((c) => c.id === done.id)!.tasks.find((x) => x.id === inReview.id)!.status).toBe("done");
    // Without moveTo, cards go to a column of the same status when there is one.
    const del2 = await call(minh, "DELETE", `/projects/${pr.id}/columns/${qa.id}`);
    expect(del2.body.movedTo).toBe(inProgress.id);
    // The last column cannot go.
    cols = await board();
    for (const c of cols.slice(1)) await call(minh, "DELETE", `/projects/${pr.id}/columns/${c.id}`);
    const last = await call(minh, "DELETE", `/projects/${pr.id}/columns/${cols[0]!.id}`);
    expect(last.status).toBe(409);
  });

  it("the free-lanes repair: whichever of column and status changed last wins", async () => {
    const pr = (await call(minh, "POST", "/projects", { name: "Drift" })).body;
    const cols = (await call(minh, "GET", `/projects/${pr.id}/board`)).body.columns as { id: string; status: string }[];
    const [todo, , review] = cols;
    const dragged = (await call(minh, "POST", "/tasks", { title: "Kéo sang Review", projectId: pr.id })).body;
    const edited = (await call(minh, "POST", "/tasks", { title: "Đổi trạng thái", projectId: pr.id })).body;
    // Recreate free-lanes drift with the sync trigger off: both cards sit in Review with status "todo".
    const owner = new pg.Client({ connectionString: "postgres://workspace_owner:owner_pw@localhost:5432/workspace_test" });
    await owner.connect();
    try {
      await owner.query("SET search_path TO work");
      await owner.query("ALTER TABLE tasks DISABLE TRIGGER tasks_column_sync");
      await owner.query("UPDATE tasks SET column_id = $2, status = 'todo' WHERE id = ANY($1)", [[dragged.id, edited.id], review!.id]);
      await owner.query("ALTER TABLE tasks ENABLE TRIGGER tasks_column_sync");
      // The dragged card's last word was a column move; the other's a status change after its move.
      await owner.query(
        `INSERT INTO activity (id, entity_type, entity_id, actor, action, changes, at) VALUES
           ($1, 'task', $2, 'minh', 'moved', '{"from":"Cần làm","to":"Chờ duyệt","column":"Chờ duyệt"}', now() - interval '1 hour'),
           ($3, 'task', $4, 'minh', 'moved', '{"from":"Cần làm","to":"Chờ duyệt","column":"Chờ duyệt"}', now() - interval '2 hours'),
           ($5, 'task', $4, 'minh', 'updated', '{"status":{"from":"in_progress","to":"todo"}}', now() - interval '1 hour')`,
        [newId(), dragged.id, newId(), edited.id, newId()],
      );
      const r = (await owner.query("SELECT * FROM work_repair_column_drift()")).rows[0];
      expect(r).toMatchObject({ by_column: 1, by_status: 1 });
      const rows = (await owner.query("SELECT id, status, column_id FROM tasks WHERE id = ANY($1)", [[dragged.id, edited.id]])).rows;
      const by = Object.fromEntries(rows.map((x) => [x.id, x]));
      expect(by[dragged.id]).toMatchObject({ status: "review", column_id: review!.id });
      expect(by[edited.id]).toMatchObject({ status: "todo", column_id: todo!.id });
      // Nothing left to repair.
      expect((await owner.query("SELECT * FROM work_repair_column_drift()")).rows[0]).toMatchObject({ by_column: 0, by_status: 0 });
    } finally {
      await owner.query("ALTER TABLE tasks ENABLE TRIGGER tasks_column_sync").catch(() => undefined);
      await owner.end();
    }
  });

  it("validates custom fields against the workspace's definitions", async () => {
    expect((await call(minh, "PUT", "/custom-fields/task/effort", { label: "Effort", type: "select", options: ["S", "M", "L"] })).status).toBe(200);
    expect((await call(lan, "POST", "/tasks", { title: "x", customFields: { effort: "XL" } })).status).toBe(400);
    expect((await call(lan, "POST", "/tasks", { title: "x", customFields: { unknown: 1 } })).status).toBe(400);
    expect((await call(minh, "PUT", "/custom-fields/task/effort?create=1", { label: "Effort 2", type: "text" })).status).toBe(409);
    const t = (await call(lan, "POST", "/tasks", { title: "x", customFields: { effort: "M" } })).body;
    expect(t.customFields).toEqual({ effort: "M" });
    // Deleting a field drops its values, so later edits that send the whole object back still validate.
    expect((await call(lan, "DELETE", "/custom-fields/task/effort")).status).toBe(403);
    expect((await call(minh, "DELETE", "/custom-fields/task/effort")).status).toBe(200);
    expect((await call(minh, "DELETE", "/custom-fields/task/effort")).status).toBe(404);
    expect((await call(lan, "GET", `/tasks/${t.id}`)).body.task.customFields).toEqual({});
  });

  it("keeps personal tasks private", async () => {
    const mine = (await call(lan, "POST", "/tasks", { title: "personal note" })).body;
    expect((await call(huy, "GET", `/tasks/${mine.id}`)).status).toBe(404);
  });

  it("insights count only tasks the caller may read", async () => {
    const secret = (await call(lan, "POST", "/tasks", { title: "lan's private note", assigneeId: "lan", dueAt: new Date(Date.now() - 86400_000).toISOString() })).body;
    const huyView = (await call(huy, "GET", "/insights")).body;
    const minhView = (await call(minh, "GET", "/insights")).body;
    expect(huyView.overdue.some((t: { id: string }) => t.id === secret.id)).toBe(false);
    expect(minhView.overdue.some((t: { id: string }) => t.id === secret.id)).toBe(true); // workspace-wide editor
    expect(minhView.totals.open).toBeGreaterThan(huyView.totals.open);
    expect(minhView.weeks).toHaveLength(8);
    expect(minhView.workload.find((w: { userId: string }) => w.userId === "lan").overdue).toBeGreaterThanOrEqual(1);
  });

  it("records traceability to the source chat message", async () => {
    const source = { type: "chat.message", messageId: newId(), channelId: newId() };
    const t = (await call(lan, "POST", "/tasks", { title: "From chat", source })).body;
    expect(t.source).toEqual(source);
    const d = (await call(lan, "POST", "/decisions", { title: "Move deadline to Oct 18", source })).body;
    const list = (await call(lan, "GET", `/decisions?channelId=${source.channelId}`)).body.decisions;
    expect(list.map((x: { id: string }) => x.id)).toContain(d.id);
  });

  it("marks a task blocked with a reason, and finishing it clears the blocker", async () => {
    const t = (await call(lan, "POST", "/tasks", { title: "Tích hợp VNPay", assigneeId: "lan" })).body;
    const b = (await call(lan, "PATCH", `/tasks/${t.id}`, { expectedVersion: t.version, blockedReason: "Chờ API key từ đối tác" })).body;
    expect(b.blockedReason).toBe("Chờ API key từ đối tác");
    const cleared = (await call(lan, "PATCH", `/tasks/${t.id}`, { expectedVersion: b.version, blockedReason: "  " })).body;
    expect(cleared.blockedReason).toBeNull();
    const again = (await call(lan, "PATCH", `/tasks/${t.id}`, { expectedVersion: cleared.version, blockedReason: "Đợi review" })).body;
    const done = (await call(lan, "PATCH", `/tasks/${t.id}`, { expectedVersion: again.version, status: "done" })).body;
    expect(done.blockedReason).toBeNull();
  });

  it("a proposed decision waits for its named decider, who alone can settle it", async () => {
    const d = (await call(lan, "POST", "/decisions", { title: "Chốt màu nút đặt lịch: xanh lá", deciderId: "minh" })).body;
    expect(d.status).toBe("proposed");
    const waiting = (await call(minh, "GET", "/decisions?waiting=me")).body.decisions;
    expect(waiting.map((x: { id: string }) => x.id)).toContain(d.id);
    expect((await call(lan, "GET", "/decisions?waiting=me")).body.decisions.map((x: { id: string }) => x.id)).not.toContain(d.id);
    expect((await call(huy, "POST", `/decisions/${d.id}/settle`, { action: "decide" })).status).toBe(403);
    expect((await call(minh, "POST", `/decisions/${d.id}/settle`, { action: "withdraw" })).status).toBe(403);
    const ok = await call(minh, "POST", `/decisions/${d.id}/settle`, { action: "decide", details: "Theo yêu cầu khách" });
    expect(ok.body).toEqual({ id: d.id, status: "decided" });
    expect((await call(minh, "POST", `/decisions/${d.id}/settle`, { action: "decide" })).status).toBe(409);
    const row = (await call(huy, "GET", "/decisions")).body.decisions.find((x: { id: string }) => x.id === d.id);
    expect(row).toMatchObject({ status: "decided", decidedBy: "minh", proposedBy: "lan", details: "Theo yêu cầu khách" });
    // The proposer can withdraw their own pending proposal.
    const w = (await call(lan, "POST", "/decisions", { title: "Đổi lịch demo", deciderId: "minh" })).body;
    expect((await call(lan, "POST", `/decisions/${w.id}/settle`, { action: "withdraw" })).body.status).toBe("withdrawn");
    expect((await call(minh, "GET", "/decisions?waiting=me")).body.decisions.map((x: { id: string }) => x.id)).not.toContain(w.id);
  });

  it("completes a task and sets completedAt", async () => {
    const t = (await call(lan, "POST", "/tasks", { title: "finish me" })).body;
    const done = (await call(lan, "PATCH", `/tasks/${t.id}`, { expectedVersion: t.version, status: "done" })).body;
    expect(done.completedAt).not.toBeNull();
    const detail = (await call(lan, "GET", `/tasks/${t.id}`)).body;
    expect(detail.activity.map((a: { action: string }) => a.action)).toEqual(["updated", "created"]);
  });
});

describe("documents and files", () => {
  let doc: any;

  it("keeps private documents private until shared", async () => {
    doc = (await call(lan, "POST", "/docs", { title: "Q4 plan", content: "# Plan" })).body;
    expect((await call(huy, "GET", `/docs/${doc.id}`)).status).toBe(404);
    await call(lan, "PUT", `/docs/${doc.id}/sharing`, { userIds: ["huy"] });
    expect((await call(huy, "GET", `/docs/${doc.id}`)).body.content).toBe("# Plan");
  });

  it("versions edits and rejects stale saves", async () => {
    const v2 = (await call(huy, "PUT", `/docs/${doc.id}`, { content: "# Plan v2", baseVersion: 1 })).body;
    expect(v2.current_version).toBe(2);
    expect((await call(lan, "PUT", `/docs/${doc.id}`, { content: "# conflicting", baseVersion: 1 })).status).toBe(409);
    expect((await call(lan, "GET", `/docs/${doc.id}?version=1`)).body.content).toBe("# Plan");
  });

  it("saves a long document (hundreds of kilobytes of Vietnamese text)", async () => {
    const long = `# Sổ tay\n${"Nội dung chi tiết của quy trình làm việc. ".repeat(6000)}`;
    expect(Buffer.byteLength(long)).toBeGreaterThan(250_000);
    const d = (await call(lan, "POST", "/docs", { title: "Sổ tay nhân viên", content: long })).body;
    expect((await call(lan, "GET", `/docs/${d.id}`)).body.content.length).toBe(long.length);
  });

  it("uploads directly to storage via presigned URL, confirms, and downloads", async () => {
    const body = "%PDF-1.4 hello";
    const up = (
      await call(lan, "POST", "/files/uploads", { name: "báo cáo.pdf", contentType: "application/pdf", size: Buffer.byteLength(body), attachTo: { type: "document", id: doc.id } })
    ).body;
    expect((await fetch(up.uploadUrl, { method: "PUT", headers: { "content-type": "application/pdf" }, body })).status).toBe(200);
    expect((await call(lan, "POST", `/files/${up.fileId}/confirm`)).body.status).toBe("active");
    expect((await call(lan, "POST", `/files/${up.fileId}/confirm`)).body.status).toBe("active"); // idempotent
    const dl = (await call(huy, "GET", `/files/${up.fileId}/download`)).body;
    expect(await (await fetch(dl.url)).text()).toBe(body);
  });

  it("denies download to users without access", async () => {
    const other = (await call(lan, "POST", "/docs", { title: "secret", content: "x" })).body;
    const up = (await call(lan, "POST", "/files/uploads", { name: "s.txt", contentType: "text/plain", size: 2, attachTo: { type: "document", id: other.id } })).body;
    await fetch(up.uploadUrl, { method: "PUT", headers: { "content-type": "text/plain" }, body: "hi" });
    await call(lan, "POST", `/files/${up.fileId}/confirm`);
    expect((await call(huy, "GET", `/files/${up.fileId}/download`)).status).toBe(404);
  });

  it("validates type and size before issuing an upload URL", async () => {
    // Any kind of file but programs and scripts (shared/upload-types.ts): HTML is accepted, a renamed program is not.
    expect((await call(lan, "POST", "/files/uploads", { name: "export.html", contentType: "text/html", size: 10, attachTo: { type: "document", id: doc.id } })).status).toBe(201);
    expect((await call(lan, "POST", "/files/uploads", { name: "run.bat", contentType: "text/plain", size: 10, attachTo: { type: "document", id: doc.id } })).status).toBe(400);
    expect(
      (await call(lan, "POST", "/files/uploads", { name: "x.exe", contentType: "application/x-msdownload", size: 10, attachTo: { type: "document", id: doc.id } })).status,
    ).toBe(400);
    expect(
      (await call(lan, "POST", "/files/uploads", { name: "big.pdf", contentType: "application/pdf", size: 60 * 1024 * 1024, attachTo: { type: "document", id: doc.id } })).status,
    ).toBe(400);
    expect((await call(huy, "POST", "/files/uploads", { name: "x.pdf", contentType: "application/pdf", size: 10, attachTo: { type: "task", id: newId() } })).status).toBe(404);
  });

  it("rejects a confirm when the uploaded object does not match and deletes it", async () => {
    const up = (await call(lan, "POST", "/files/uploads", { name: "x.txt", contentType: "text/plain", size: 2, attachTo: { type: "document", id: doc.id } })).body;
    expect((await call(lan, "POST", `/files/${up.fileId}/confirm`)).status).toBe(400); // nothing uploaded yet
  });

  it("sweeps expired pending uploads and their objects", async () => {
    const up = (await call(lan, "POST", "/files/uploads", { name: "abandoned.txt", contentType: "text/plain", size: 2, attachTo: { type: "document", id: doc.id } })).body;
    await fetch(up.uploadUrl, { method: "PUT", headers: { "content-type": "text/plain" }, body: "hi" });
    const key = `documents/${up.fileId}`;
    expect(await storage.head(key)).not.toBeNull();
    await runWithContext({ actorId: "test", requestId: newId() }, () =>
      withTransaction(pool, (c) => c.query("UPDATE files SET expires_at = now() - interval '1 minute' WHERE id = $1", [up.fileId])),
    );
    expect(await sweepPendingFiles(pool, storage)).toBeGreaterThanOrEqual(1);
    expect(await storage.head(key)).toBeNull();
    expect((await call(lan, "POST", `/files/${up.fileId}/confirm`)).status).toBe(404);
  });
});

describe("calendar and approvals", () => {
  it("schedules meetings and lists them for attendees only", async () => {
    const ev = (
      await call(minh, "POST", "/calendar/events", { title: "Standup", startsAt: "2026-10-09T09:00:00+07:00", endsAt: "2026-10-09T09:15:00+07:00", attendeeIds: ["lan"] })
    ).body;
    const range = "from=2026-10-09T00:00:00Z&to=2026-10-10T00:00:00Z";
    expect((await call(lan, "GET", `/calendar/events?${range}`)).body.events.map((e: { id: string }) => e.id)).toContain(ev.id);
    expect((await call(huy, "GET", `/calendar/events?${range}`)).body.events.map((e: { id: string }) => e.id)).not.toContain(ev.id);
    expect((await call(minh, "POST", "/calendar/events", { title: "bad", startsAt: "2026-10-09T10:00:00Z", endsAt: "2026-10-09T09:00:00Z" })).status).toBe(400);
    // Dragging it to the next day (organizer only), like Google Calendar.
    expect((await call(lan, "PATCH", `/calendar/events/${ev.id}`, { startsAt: "2026-10-10T09:00:00+07:00", endsAt: "2026-10-10T09:15:00+07:00" })).status).toBe(403);
    const moved = await call(minh, "PATCH", `/calendar/events/${ev.id}`, { startsAt: "2026-10-10T10:00:00+07:00", endsAt: "2026-10-10T10:30:00+07:00" });
    expect(moved.status).toBe(200);
    const next = (await call(lan, "GET", "/calendar/events?from=2026-10-10T00:00:00Z&to=2026-10-11T00:00:00Z")).body.events.find((e: { id: string }) => e.id === ev.id);
    expect(new Date(next.startsAt).toISOString()).toBe("2026-10-10T03:00:00.000Z");
    expect((await call(minh, "PATCH", `/calendar/events/${ev.id}`, { endsAt: "2026-10-10T09:00:00+07:00" })).status).toBe(400);
  });

  it("only the approver decides, exactly once, and nobody approves their own request", async () => {
    expect((await call(lan, "POST", "/approvals", { title: "self", approverId: "lan" })).status).toBe(400);
    const a = (await call(lan, "POST", "/approvals", { title: "Chi phí Q4", approverId: "huy" })).body;
    expect((await call(lan, "POST", `/approvals/${a.id}/decision`, { decision: "approved" })).status).toBe(403);
    expect((await call(huy, "POST", `/approvals/${a.id}/decision`, { decision: "approved" })).status).toBe(204);
    expect((await call(huy, "POST", `/approvals/${a.id}/decision`, { decision: "rejected" })).status).toBe(409);
  });

  it("requester and approver talk on a request, and the approver can forward it to someone else", async () => {
    const a = (await call(lan, "POST", "/approvals", { title: "Mua màn hình", approverId: "huy", kind: "purchase", amount: 6_000_000 })).body;
    expect((await call(huy, "POST", `/approvals/${a.id}/comments`, { body: "Cần thêm báo giá" })).status).toBe(201);
    expect((await call(lan, "POST", `/approvals/${a.id}/comments`, { body: "Đã gửi báo giá" })).status).toBe(201);
    expect((await call(lan, "POST", `/approvals/${a.id}/comments`, { body: "  " })).status).toBe(400);
    const seen = (await call(huy, "GET", `/approvals/${a.id}`)).body;
    expect(seen.events.map((e: { kind: string; actorId: string }) => `${e.kind}:${e.actorId}`)).toEqual(["comment:huy", "comment:lan"]);
    expect(seen.requesterStats).toMatchObject({ total: expect.any(Number), approved: expect.any(Number) });
    expect((await call(lan, "GET", `/approvals/${a.id}`)).body.requesterStats).toBeNull();

    expect((await call(lan, "POST", `/approvals/${a.id}/forward`, { toUserId: "an" })).status).toBe(403);
    expect((await call(huy, "POST", `/approvals/${a.id}/forward`, { toUserId: "lan" })).status).toBe(400);
    expect((await call(huy, "POST", `/approvals/${a.id}/forward`, { toUserId: "an", note: "Kế toán duyệt" })).status).toBe(201);
    expect((await call(huy, "POST", `/approvals/${a.id}/decision`, { decision: "approved" })).status).toBe(403);
    const after = (await call(lan, "GET", `/approvals/${a.id}`)).body;
    expect(after).toMatchObject({ approverId: "an", status: "pending" });
    expect(after.events.at(-1)).toMatchObject({ kind: "forwarded", actorId: "huy", targetId: "an", body: "Kế toán duyệt" });
    expect((await call(minh, "POST", `/approvals/${a.id}/decision`, { decision: "approved" })).status).toBe(204);
    expect((await call(minh, "POST", `/approvals/${a.id}/forward`, { toUserId: "huy" })).status).toBe(409);
  });

  it("a company's own request template: admins create it, everyone uses it", async () => {
    const tpl = {
      name: "Đề xuất tuyển dụng",
      icon: "🧑‍💼",
      fields: [
        { label: "Vị trí", type: "text" },
        { label: "Lý do", type: "textarea" },
      ],
      money: true,
      approverId: "huy",
    };
    expect((await call(lan, "POST", "/request-templates", tpl)).status).toBe(403);
    const made = await call(minh, "POST", "/request-templates", tpl);
    expect(made.status).toBe(201);
    const seen = (await call(lan, "GET", "/request-templates")).body;
    expect(seen.canManage).toBe(false);
    expect(seen.templates.find((x: { id: string }) => x.id === made.body.id)).toMatchObject({ name: "Đề xuất tuyển dụng", money: true, approverId: "huy" });
    const r = await call(lan, "POST", "/approvals", {
      title: "Đề xuất tuyển dụng: 1 Backend",
      approverId: "huy",
      templateId: made.body.id,
      amount: 25_000_000,
      fields: { "Vị trí": "Backend" },
    });
    expect(r.status).toBe(201);
    expect((await call(huy, "GET", "/approvals")).body.approvals.find((x: { id: string }) => x.id === r.body.id)).toMatchObject({ kind: "other", templateId: made.body.id });
    expect((await call(minh, "DELETE", `/request-templates/${made.body.id}`)).status).toBe(204);
    expect((await call(lan, "GET", "/request-templates")).body.templates.some((x: { id: string }) => x.id === made.body.id)).toBe(false);
  });

  it("a request has a type, an amount and its template's fields (Vận hành)", async () => {
    const r = await call(lan, "POST", "/approvals", {
      title: "Tạm ứng công tác Đà Nẵng",
      approverId: "huy",
      kind: "advance",
      amount: 5_000_000,
      fields: { purpose: "Gặp đối tác", dates: "20–22/10" },
    });
    expect(r.status).toBe(201);
    const list = (await call(huy, "GET", "/approvals")).body.approvals;
    expect(list.find((x: { id: string }) => x.id === r.body.id)).toMatchObject({
      kind: "advance",
      amount: 5_000_000,
      currency: "VND",
      fields: { purpose: "Gặp đối tác" },
    });
    expect((await call(lan, "POST", "/approvals", { title: "x", approverId: "huy", kind: "bribe" })).status).toBe(400);
    expect((await call(lan, "POST", "/approvals", { title: "x", approverId: "huy", amount: -1 })).status).toBe(400);
    // Purchases, payments and advances are decided on their amount: none, no request.
    const noAmount = await call(lan, "POST", "/approvals", { title: "Laptop", approverId: "huy", kind: "purchase" });
    expect(noAmount.status).toBe(400);
    expect(noAmount.body.error).toBe("amount_required");
  });

  it("an amount carries its currency", async () => {
    const usd = (await call(lan, "POST", "/approvals", { title: "SaaS seat", approverId: "huy", kind: "payment", amount: 120.5, currency: "USD" })).body;
    const list = (await call(huy, "GET", "/approvals")).body.approvals;
    expect(list.find((x: { id: string }) => x.id === usd.id)).toMatchObject({ amount: 120.5, currency: "USD" });
    expect((await call(lan, "POST", "/approvals", { title: "x", approverId: "huy", amount: 1, currency: "dollars" })).status).toBe(400);
    const detail = (await call(huy, "GET", `/approvals/${usd.id}`)).body;
    expect(detail).toMatchObject({ amount: 120.5, currency: "USD" });
    expect(detail.requesterStats).toMatchObject({ currency: "USD" });
  });
});

describe("meetings", () => {
  it("attendees co-write agenda and minutes; only the organizer reschedules; outsiders see nothing", async () => {
    const start = new Date(Date.now() + 3600_000);
    const ev = (
      await call(minh, "POST", "/calendar/events", {
        title: "Giao ban tuần",
        startsAt: start.toISOString(),
        endsAt: new Date(start.getTime() + 1800_000).toISOString(),
        attendeeIds: ["lan"],
      })
    ).body;
    let m = (await call(lan, "GET", `/meetings/${ev.id}`)).body;
    expect(m.attendees.map((a: { userId: string }) => a.userId).sort()).toEqual(["lan", "minh"]);
    m = (await call(lan, "PATCH", `/meetings/${ev.id}`, { expectedVersion: m.event.version, agenda: "1. Tiến độ\n2. Rủi ro" })).body;
    expect(m.event.agenda).toContain("Tiến độ");
    expect((await call(lan, "PATCH", `/meetings/${ev.id}`, { expectedVersion: m.event.version, title: "Đổi tên" })).status).toBe(403);
    expect((await call(minh, "PATCH", `/meetings/${ev.id}`, { expectedVersion: 1, notes: "cũ" })).status).toBe(409);
    expect((await call(huy, "GET", `/meetings/${ev.id}`)).status).toBe(404);
    m = (await call(minh, "PATCH", `/meetings/${ev.id}`, { expectedVersion: m.event.version, notes: "Chốt demo thứ Ba.", attendeeIds: ["lan", "huy"] })).body;
    expect(m.attendees.map((a: { userId: string }) => a.userId).sort()).toEqual(["huy", "lan", "minh"]);
    // Action items are tasks that point back to the meeting.
    await call(lan, "POST", "/tasks", { title: "Chuẩn bị slide demo", assigneeId: "lan", source: { type: "meeting", eventId: ev.id } });
    m = (await call(huy, "GET", `/meetings/${ev.id}`)).body;
    expect(m.actionItems.map((t: { title: string }) => t.title)).toEqual(["Chuẩn bị slide demo"]);
    const up = (await call(lan, "GET", "/meetings")).body.meetings.find((x: { id: string }) => x.id === ev.id);
    expect(up).toMatchObject({ hasAgenda: true, hasNotes: true, actionItems: 1, openActionItems: 1, attendeeCount: 3 });
    expect(up.attendeeIds[0]).toBe("minh"); // the organizer first
    // What meetings left behind: the open action item, for anyone who attended; not for people who were not there.
    const f = (await call(huy, "GET", "/meetings/followups")).body;
    expect(f.actionItems.map((t: { title: string; meetingId: string }) => [t.title, t.meetingId])).toEqual([["Chuẩn bị slide demo", ev.id]]);
    expect((await call(mk("outsider", EMPLOYEE), "GET", "/meetings/followups")).body.actionItems).toEqual([]);
  });
});

describe("project counters", () => {
  it("keeps done/total counts and the open-task numbers on the list in step with the tasks", async () => {
    const pr = (await call(lan, "POST", "/projects", { name: "Đếm việc" })).body;
    const a = (await call(lan, "POST", "/tasks", { title: "a", projectId: pr.id, assigneeId: "lan", dueAt: new Date(Date.now() - 86400_000).toISOString() })).body;
    const b = (await call(lan, "POST", "/tasks", { title: "b", projectId: pr.id, assigneeId: "huy" })).body;
    await call(lan, "PATCH", `/tasks/${a.id}`, { expectedVersion: a.version, status: "done" });
    await call(lan, "PATCH", `/tasks/${b.id}`, { expectedVersion: b.version, status: "cancelled" });
    const row = (await call(lan, "GET", "/projects")).body.projects.find((x: { id: string }) => x.id === pr.id);
    expect(row).toMatchObject({ doneTasks: 1, totalTasks: 1, openTasks: 0, overdueTasks: 0 });
    const c = (await call(lan, "POST", "/tasks", { title: "c", projectId: pr.id, assigneeId: "huy", dueAt: new Date(Date.now() - 86400_000).toISOString() })).body;
    const again = (await call(lan, "GET", "/projects")).body.projects.find((x: { id: string }) => x.id === pr.id);
    expect(again).toMatchObject({ doneTasks: 1, totalTasks: 2, openTasks: 1, overdueTasks: 1 });
    expect(again.people).toContain("huy");
    expect(again.lastActivityAt).toBeTruthy();
    expect((await call(minh, "DELETE", `/tasks/${c.id}`)).status).toBe(204);
    const after = (await call(lan, "GET", "/projects?limit=200")).body.projects.find((x: { id: string }) => x.id === pr.id);
    expect(after).toMatchObject({ totalTasks: 1, openTasks: 0 });
    // The project list pages: `limit=1` answers with one row.
    expect((await call(lan, "GET", "/projects?limit=1")).body.projects).toHaveLength(1);
  });

  it("pages a project's task list with a cursor", async () => {
    const pr = (await call(lan, "POST", "/projects", { name: "Nhiều việc" })).body;
    for (let i = 0; i < 3; i++)
      await call(lan, "POST", "/tasks", { title: `t${i}`, projectId: pr.id, assigneeId: "lan", dueAt: new Date(Date.now() + i * 86400_000).toISOString() });
    const first = (await call(lan, "GET", `/tasks?projectId=${pr.id}`)).body;
    expect(first.tasks).toHaveLength(3);
    expect(first.nextCursor).toBeNull();
  });
});

describe("task creation with every field", () => {
  it("takes a start date with the due date and refuses one after it", async () => {
    const t = (await call(lan, "POST", "/tasks", { title: "Khảo sát khách hàng", startAt: "2026-11-02T01:00:00Z", dueAt: "2026-11-06T10:00:00Z" })).body;
    expect(t.startAt).toBeTruthy();
    expect((await call(lan, "POST", "/tasks", { title: "Ngược", startAt: "2026-11-09T01:00:00Z", dueAt: "2026-11-06T10:00:00Z" })).status).toBe(400);
  });
});

describe("codes in place of ids", () => {
  it("reads a task, project and document by code, in any case, within the workspace only", async () => {
    const pr = (await call(lan, "POST", "/projects", { name: "Mã dễ đọc" })).body;
    const t = (await call(lan, "POST", "/tasks", { title: "Chia sẻ bằng mã", projectId: pr.id })).body;
    const d = (await call(lan, "POST", "/docs", { title: "Ghi chú mã", content: "# Mã" })).body;
    const code = (await call(lan, "GET", `/tasks/${t.id}`)).body.task.code as string;
    expect(code).toMatch(/\d/);
    for (const ref of [code, code.toLowerCase(), t.id]) expect((await call(lan, "GET", `/tasks/${encodeURIComponent(ref)}`)).body.task.id).toBe(t.id);
    const prCode = (await call(lan, "GET", `/projects/${pr.id}`)).body.code as string;
    expect((await call(lan, "GET", `/projects/${prCode.toLowerCase()}`)).body.id).toBe(pr.id);
    expect((await call(lan, "GET", `/projects/${prCode}/board`)).status).toBe(200);
    const docCode = (await call(lan, "GET", `/docs/${d.id}`)).body.document.code as string;
    expect((await call(lan, "GET", `/docs/${docCode}?track=0`)).body.document.id).toBe(d.id);
    expect((await call(lan, "GET", "/tasks/KHONG-CO-999")).status).toBe(404);
  });
});

describe("task comments: edit and delete", () => {
  it("lets the author edit (only new mentions are announced), the author or a task deleter delete, nobody else", async () => {
    const pr = (await call(lan, "POST", "/projects", { name: "Bình luận" })).body;
    const t = (await call(lan, "POST", "/tasks", { title: "Chuẩn bị demo", projectId: pr.id })).body;
    const mine = (await call(lan, "POST", `/tasks/${t.id}/comments`, { body: "Nhờ <@huy> xem giúp" })).body;
    const his = (await call(huy, "POST", `/tasks/${t.id}/comments`, { body: "Ok, chiều nay" })).body;

    // Only the author edits; an edit with new mentions announces just those.
    expect((await call(huy, "PATCH", `/tasks/${t.id}/comments/${mine.id}`, { body: "sửa trộm" })).status).toBe(403);
    expect((await call(minh, "PATCH", `/tasks/${t.id}/comments/${mine.id}`, { body: "sửa trộm" })).status).toBe(403);
    const edited = (await call(lan, "PATCH", `/tasks/${t.id}/comments/${mine.id}`, { body: "Nhờ <@huy> và <@minh> xem giúp" })).body;
    expect(edited).toMatchObject({ id: mine.id, body: "Nhờ <@huy> và <@minh> xem giúp" });
    expect(edited.editedAt).toBeTruthy();
    const ev = await runWithContext({ actorId: "test", requestId: newId() }, () =>
      withTransaction(pool, (c) => c.query("SELECT payload FROM outbox WHERE type = 'work.task.comment_edited.v1' AND aggregateid = $1", [t.id])),
    );
    expect(ev.rows.map((r) => r.payload.payload.mentions)).toEqual([["minh"]]);
    expect((await call(lan, "PATCH", `/tasks/${t.id}/comments/${mine.id}`, { body: "" })).status).toBe(400);

    // Deleting: not another employee; yes the author, yes whoever may delete the task.
    expect((await call(huy, "DELETE", `/tasks/${t.id}/comments/${mine.id}`)).status).toBe(403);
    expect((await call(minh, "DELETE", `/tasks/${t.id}/comments/${his.id}`)).status).toBe(204);
    expect((await call(lan, "DELETE", `/tasks/${t.id}/comments/${mine.id}`)).status).toBe(204);
    expect((await call(lan, "DELETE", `/tasks/${t.id}/comments/${mine.id}`)).status).toBe(404);
    const d = (await call(lan, "GET", `/tasks/${t.id}`)).body;
    expect(d.comments).toEqual([]);
    expect(
      d.activity
        .filter((a: { action: string }) => a.action === "comment_deleted")
        .map((a: { changes: { authorId: string } }) => a.changes.authorId)
        .sort(),
    ).toEqual(["huy", "lan"]);
  });
});

describe("project editing", () => {
  it("owner edits and archives; others cannot; the due-date change is traceable", async () => {
    const pr = (await call(lan, "POST", "/projects", { name: "Chiến dịch quý 4" })).body;
    let d = (await call(lan, "GET", `/projects/${pr.id}`)).body;
    expect((await call(huy, "PATCH", `/projects/${pr.id}`, { expectedVersion: d.version, name: "Hack" })).status).toBe(403);
    const u = (await call(lan, "PATCH", `/projects/${pr.id}`, { expectedVersion: d.version, dueAt: "2026-10-18T10:00:00+07:00", reason: "Thống nhất trong thread #launch" })).body;
    expect(u.dueAt).toBeTruthy();
    expect((await call(lan, "PATCH", `/projects/${pr.id}`, { expectedVersion: d.version, name: "stale" })).status).toBe(409);
    d = (await call(lan, "GET", `/projects/${pr.id}`)).body;
    expect(d.history[0].changes).toMatchObject({ reason: "Thống nhất trong thread #launch" });
    expect(d.history[0].changes.due_at).toBeTruthy();
    await call(lan, "PATCH", `/projects/${pr.id}`, { expectedVersion: d.version, status: "archived" });
    expect((await call(lan, "GET", "/projects")).body.projects.some((x: { id: string }) => x.id === pr.id)).toBe(false);
    expect((await call(lan, "GET", "/projects?status=archived")).body.projects.some((x: { id: string }) => x.id === pr.id)).toBe(true);
  });
});

describe("project team and TEAM-scope grants", () => {
  it("is created with its lead and team at once", async () => {
    const teamId = newId();
    const pr = (await call(lan, "POST", "/projects", { name: "Cổng đối tác", description: "Phạm vi: đăng ký và báo cáo", ownerId: "minh", teamId })).body;
    const d = (await call(lan, "GET", `/projects/${pr.id}`)).body;
    expect(d).toMatchObject({ ownerId: "minh", teamId, description: "Phạm vi: đăng ký và báo cáo" });
    expect((await call(lan, "GET", `/projects/${(await call(lan, "POST", "/projects", { name: "Mặc định" })).body.id}`)).body.ownerId).toBe("lan");
  });

  it("a TEAM-scoped manager gains edit rights once the project is assigned to their team; existing tasks follow", async () => {
    const teamId = newId();
    const manager: Principal = {
      type: "user",
      id: "mgr-team",
      teamIds: [teamId],
      departmentId: null,
      grants: [...EMPLOYEE, { permission: "task.edit", scope: "TEAM" }, { permission: "project.edit", scope: "TEAM" }],
    };
    const pr = (await call(lan, "POST", "/projects", { name: "Ứng dụng di động" })).body;
    const t = (await call(lan, "POST", "/tasks", { title: "Màn đăng nhập", projectId: pr.id })).body;
    let d = (await call(lan, "GET", `/projects/${pr.id}`)).body;
    expect(d.teamId).toBeNull();
    let task = (await call(lan, "GET", `/tasks/${t.id}`)).body.task;
    expect((await call(manager, "PATCH", `/tasks/${t.id}`, { expectedVersion: task.version, title: "Hack" })).status).toBe(403);
    expect((await call(manager, "PATCH", `/projects/${pr.id}`, { expectedVersion: d.version, name: "Hack" })).status).toBe(403);
    expect((await call(lan, "PATCH", `/projects/${pr.id}`, { expectedVersion: d.version, teamId })).body.teamId).toBe(teamId);
    d = (await call(lan, "GET", `/projects/${pr.id}`)).body;
    expect(d.history[0].changes.team_id).toEqual({ from: null, to: teamId });
    task = (await call(lan, "GET", `/tasks/${t.id}`)).body.task;
    expect(task.teamId).toBe(teamId);
    expect((await call(manager, "PATCH", `/tasks/${t.id}`, { expectedVersion: task.version, title: "Màn đăng nhập (SSO)" })).status).toBe(200);
    expect((await call(manager, "PATCH", `/projects/${pr.id}`, { expectedVersion: d.version, teamId: null })).status).toBe(200);
    task = (await call(lan, "GET", `/tasks/${t.id}`)).body.task;
    expect(task.teamId).toBeNull();
  });
});

describe("offboarding handover", () => {
  it("moves a leaver's open tasks, pending approvals and decisions to a colleague (admins only)", async () => {
    const admin = mk("minh", [...ADMIN, ...T("member.manage")]);
    const open = (await call(minh, "POST", "/tasks", { title: "Việc dở dang", assigneeId: "huy" })).body;
    const proj = (await call(huy, "POST", "/projects", { name: "Dự án của Huy" })).body;
    const finished = (await call(minh, "POST", "/tasks", { title: "Việc đã xong", assigneeId: "huy" })).body;
    await call(minh, "PATCH", `/tasks/${finished.id}`, { expectedVersion: finished.version, status: "done" });
    const ap = (await call(lan, "POST", "/approvals", { title: "Mua laptop", approverId: "huy" })).body;
    const dec = (await call(lan, "POST", "/decisions", { title: "Chọn nhà cung cấp", deciderId: "huy" })).body;

    expect((await call(minh, "GET", "/handover/huy")).status).toBe(403); // task admin is not enough
    const summary = (await call(admin, "GET", "/handover/huy")).body;
    expect(summary).toMatchObject({ tasks: expect.any(Number), approvals: expect.any(Number), decisions: expect.any(Number) });
    expect(summary.tasks).toBeGreaterThanOrEqual(1);
    expect((await call(admin, "POST", "/handover/huy", { toUserId: "huy" })).status).toBe(400);

    const moved = (await call(admin, "POST", "/handover/huy", { toUserId: "lan" })).body;
    expect(moved).toEqual(summary);
    expect((await call(admin, "GET", "/handover/huy")).body).toEqual({ tasks: 0, approvals: 0, decisions: 0, projects: 0 });
    const t = (await call(admin, "GET", `/tasks/${open.id}`)).body;
    expect(t.task.assigneeId).toBe("lan");
    expect(t.activity.some((a: { changes: { assignee_id?: { from: string; to: string } } }) => a.changes.assignee_id?.from === "huy")).toBe(true);
    expect((await call(admin, "GET", `/tasks/${finished.id}`)).body.task.assigneeId).toBe("huy"); // finished work keeps its history
    expect((await call(lan, "GET", `/approvals/${ap.id}`)).body).toMatchObject({ approverId: "lan", canDecide: true });
    const decs = (await call(lan, "GET", "/decisions")).body.decisions as { id: string; deciderId?: string }[];
    expect(decs.find((x) => x.id === dec.id)?.deciderId).toBe("lan");
    expect(proj.id).toBeTruthy();
    expect((await call(admin, "GET", `/projects/${proj.id}`)).body.ownerId).toBe("lan");
  });
});

describe("recurring meetings", () => {
  it("creates a weekly series of separate meetings and cancels one or the rest", async () => {
    const start = new Date(Date.now() + 86400_000);
    start.setUTCHours(2, 0, 0, 0);
    const until = new Date(start.getTime() + 21 * 86400_000 + 3600_000);
    const r = (
      await call(minh, "POST", "/calendar/events", {
        title: "Giao ban tuần",
        startsAt: start.toISOString(),
        endsAt: new Date(start.getTime() + 1800_000).toISOString(),
        attendeeIds: ["lan"],
        recurrence: { rule: "weekly", until: until.toISOString(), timeZone: "Asia/Ho_Chi_Minh" },
      })
    ).body;
    expect(r.occurrences).toBe(4);
    const range = `from=${encodeURIComponent(start.toISOString())}&to=${encodeURIComponent(new Date(until.getTime() + 86400_000).toISOString())}`;
    const series = () =>
      call(lan, "GET", `/calendar/events?${range}`).then((x) =>
        (x.body.events as { id: string; seriesId: string; recurrence: string; startsAt: string }[]).filter((e) => e.seriesId === r.seriesId),
      );
    const all = await series();
    expect(all.map((e) => e.recurrence)).toEqual(["weekly", "weekly", "weekly", "weekly"]);
    expect(new Set(all.map((e) => new Date(e.startsAt).getUTCHours()))).toEqual(new Set([2]));
    expect(
      (
        await call(minh, "POST", "/calendar/events", {
          title: "x",
          startsAt: start.toISOString(),
          endsAt: start.toISOString(),
          recurrence: { rule: "weekly", until: start.toISOString(), timeZone: "Mars/Olympus" },
        })
      ).status,
    ).toBe(400);

    const second = (await call(lan, "GET", `/meetings/${all[1]!.id}`)).body;
    expect(second.series).toMatchObject({ id: r.seriesId, recurrence: "weekly", previous: { id: all[0]!.id }, next: { id: all[2]!.id } });
    expect((await call(lan, "DELETE", `/calendar/events/${all[1]!.id}?scope=following`)).status).toBe(403); // organizer only
    await call(minh, "DELETE", `/calendar/events/${all[1]!.id}`); // just that one
    expect((await series()).map((e) => e.id)).toEqual([all[0]!.id, all[2]!.id, all[3]!.id]);
    await call(minh, "DELETE", `/calendar/events/${all[2]!.id}?scope=following`); // this and later
    expect((await series()).map((e) => e.id)).toEqual([all[0]!.id]);
  });
});

describe("document history", () => {
  it("lists versions with authors and restores an old one as a new version", async () => {
    const d = (await call(minh, "POST", "/docs", { title: "Quy chế", content: "Bản 1", visibility: "workspace" })).body;
    const v2 = (await call(minh, "PUT", `/docs/${d.id}`, { content: "Bản 2", baseVersion: 1 })).body;
    await call(lan, "PUT", `/docs/${d.id}`, { content: "Bản 3 của Lan", baseVersion: v2.current_version }).catch(() => undefined);
    const versions = (await call(minh, "GET", `/docs/${d.id}/versions`)).body.versions as { version: number; authorId: string }[];
    expect(versions[0]!.version).toBeGreaterThanOrEqual(2);
    expect(versions.at(-1)).toMatchObject({ version: 1, authorId: "minh" });
    const current = versions[0]!.version;
    expect((await call(minh, "POST", `/docs/${d.id}/restore`, { version: 1, baseVersion: 1 })).status).toBe(409); // stale: the document moved on
    const r = (await call(minh, "POST", `/docs/${d.id}/restore`, { version: 1, baseVersion: current })).body;
    expect(r.current_version).toBe(current + 1);
    expect((await call(minh, "GET", `/docs/${d.id}`)).body.content).toBe("Bản 1");
    expect((await call(minh, "GET", `/docs/${d.id}?version=${current}`)).body.content).not.toBe("Bản 1"); // history kept
  });
});

describe("usage stats (admin overview)", () => {
  it("counts tasks created and finished per day, documents edited and meetings held", async () => {
    const admin = mk("minh", [...ADMIN, ...T("audit.read")]);
    expect((await call(lan, "GET", "/stats/activity")).status).toBe(403);
    const before = (await call(admin, "GET", "/stats/activity?days=7")).body;
    const t = (await call(minh, "POST", "/tasks", { title: "Đếm việc" })).body;
    await call(minh, "PATCH", `/tasks/${t.id}`, { expectedVersion: t.version, status: "done" });
    await call(minh, "POST", "/docs", { title: "Đếm tài liệu", content: "x" });
    const after = (await call(admin, "GET", "/stats/activity?days=7")).body;
    expect(after.days).toHaveLength(7);
    expect(after.days.at(-1).created).toBe(before.days.at(-1).created + 1);
    expect(after.days.at(-1).done).toBe(before.days.at(-1).done + 1);
    expect(after.totals.docsEdited).toBeGreaterThanOrEqual(1);
  });
});

describe("out-of-office delegation", () => {
  it("routes new approvals to my delegate while I am away, optionally moves pending ones, and stops after", async () => {
    const pending = (await call(lan, "POST", "/approvals", { title: "Trước khi đi", approverId: "minh" })).body;
    const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
    expect((await call(minh, "PUT", "/me/delegation", { delegateId: "minh", until: today })).status).toBe(400);
    expect((await call(minh, "PUT", "/me/delegation", { delegateId: "huy", until: "2020-01-01" })).status).toBe(400);
    const set = (await call(minh, "PUT", "/me/delegation", { delegateId: "huy", until: today, movePending: true })).body;
    expect(set.moved).toBeGreaterThanOrEqual(1);
    expect((await call(minh, "GET", "/me/delegation")).body.delegation).toMatchObject({ delegateId: "huy", until: today, active: true });
    expect((await call(huy, "GET", "/me/delegation")).body.forMe).toContainEqual({ userId: "minh", until: today });

    const moved = (await call(huy, "GET", `/approvals/${pending.id}`)).body;
    expect(moved).toMatchObject({ approverId: "huy", onBehalfOf: "minh", canDecide: true });
    expect((await call(minh, "GET", `/approvals/${pending.id}`)).status).toBe(200); // still visible to the person away

    const fresh = (await call(lan, "POST", "/approvals", { title: "Trong lúc vắng", approverId: "minh" })).body;
    expect(fresh).toMatchObject({ approverId: "huy", onBehalfOf: "minh" });
    // The delegate never approves their own request: it stays with the original approver.
    expect((await call(huy, "POST", "/approvals", { title: "Của chính Huy", approverId: "minh" })).body).toMatchObject({ approverId: "minh", onBehalfOf: null });

    expect((await call(minh, "DELETE", "/me/delegation")).status).toBe(204);
    expect((await call(lan, "POST", "/approvals", { title: "Đã về", approverId: "minh" })).body.approverId).toBe("minh");
  });
});

describe("recurring tasks", () => {
  it("finishing a recurring task creates the next one with the next due date; a due date is required", async () => {
    expect((await call(minh, "POST", "/tasks", { title: "Không hạn", recurrence: "weekly" })).status).toBe(400);
    const due = new Date(Date.now() + 2 * 86400_000);
    const t = (await call(minh, "POST", "/tasks", { title: "Báo cáo tuần", assigneeId: "lan", dueAt: due.toISOString(), recurrence: "weekly", labels: ["báo cáo"] })).body;
    expect(t.recurrence).toBe("weekly");
    await call(lan, "PATCH", `/tasks/${t.id}`, { expectedVersion: t.version, status: "done" });
    const detail = (await call(minh, "GET", `/tasks/${t.id}`)).body;
    const recurred = detail.activity.find((a: { action: string }) => a.action === "recurred");
    expect(recurred).toBeTruthy();
    const next = (await call(minh, "GET", `/tasks/${recurred.changes.nextTaskId}`)).body.task;
    expect(next).toMatchObject({
      title: "Báo cáo tuần",
      assigneeId: "lan",
      status: "todo",
      recurrence: "weekly",
      labels: ["báo cáo"],
      source: { type: "recurring", fromTaskId: t.id },
    });
    expect(Date.parse(next.dueAt) - due.getTime()).toBe(7 * 86400_000);
    // Turning recurrence off: finishing creates nothing new.
    const n2 = (await call(minh, "PATCH", `/tasks/${next.id}`, { expectedVersion: next.version, recurrence: null })).body;
    await call(minh, "PATCH", `/tasks/${next.id}`, { expectedVersion: n2.version, status: "done" });
    const after = (await call(minh, "GET", `/tasks/${next.id}`)).body;
    expect(after.activity.some((a: { action: string }) => a.action === "recurred")).toBe(false);
  });
});

describe("deleting a task", () => {
  it("lets whoever created it or a task deleter delete it, not the assignee", async () => {
    const t = (await call(lan, "POST", "/tasks", { title: "Xoá được", assigneeId: "huy" })).body;
    expect((await call(lan, "GET", `/tasks/${t.id}`)).body.canDelete).toBe(true);
    expect((await call(huy, "GET", `/tasks/${t.id}`)).body.canDelete).toBe(false);
    expect((await call(huy, "DELETE", `/tasks/${t.id}`)).status).toBe(403);
    expect((await call(lan, "DELETE", `/tasks/${t.id}`)).status).toBe(204);
    // Assigned to Lan so she can see it (a personal task would be a 404): being the assignee is not enough to delete.
    const u = (await call(huy, "POST", "/tasks", { title: "Của Huy", assigneeId: "lan" })).body;
    expect((await call(lan, "DELETE", `/tasks/${u.id}`)).status).toBe(403);
    expect((await call(minh, "DELETE", `/tasks/${u.id}`)).status).toBe(204);
  });
});
