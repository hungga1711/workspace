import { gw, GatewayError } from "@/lib/gateway";
import { getT } from "@/lib/i18n/server";
import { csvCell } from "@/lib/csv";
import type { Task } from "@/components/work/types";

const MAX_ROWS = 10_000;

/**
 * The task list as CSV, with the list's own filters applied (`q`, `project`, `priority`, `done=1`) so the file matches
 * the screen. `projectId=` exports one project's list; `scope=assigned|owned` exports "my tasks" by following the
 * API's cursor. Rows stream out as they arrive; the file stops at 10,000 rows and says so in its last line.
 */
export async function GET(req: Request) {
  const tx = await getT();
  const url = new URL(req.url);
  const projectId = url.searchParams.get("projectId");
  const scope = url.searchParams.get("scope") === "owned" ? "owned" : "assigned";
  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
  const project = url.searchParams.get("project") ?? "";
  const priority = url.searchParams.get("priority") ?? "";
  const done = url.searchParams.get("done") === "1";
  let members: { userId: string; displayName: string }[] = [];
  let projects: { id: string; name: string }[] = [];
  try {
    [members, projects] = await Promise.all([
      gw<{ members: { userId: string; displayName: string }[] }>("/api/identity/members")
        .then((r) => r.members)
        .catch(() => []),
      gw<{ projects: { id: string; name: string }[] }>("/api/work/projects")
        .then((r) => r.projects)
        .catch(() => []),
    ]);
  } catch (e) {
    if (e instanceof GatewayError) return new Response(tx("work.tasklist.exportFailed"), { status: e.status });
    throw e;
  }
  const name = new Map(members.map((m) => [m.userId, m.displayName]));
  const projectName = new Map(projects.map((p) => [p.id, p.name]));
  const status: Record<string, string> = {
    todo: tx("format.status.todo"),
    in_progress: tx("format.status.in_progress"),
    review: tx("format.status.review"),
    done: tx("format.status.done"),
    cancelled: tx("format.status.cancelled"),
  };
  const prio: Record<string, string> = {
    low: tx("format.priority.low"),
    medium: tx("format.priority.medium"),
    high: tx("format.priority.high"),
    urgent: tx("format.priority.urgent"),
  };
  const keep = (t: Task) =>
    (!q || t.title.toLowerCase().includes(q) || t.code.toLowerCase().includes(q)) &&
    (!project || (project === "none" ? !t.projectId : t.projectId === project)) &&
    (!priority || t.priority === priority) &&
    (done || (t.status !== "done" && t.status !== "cancelled"));
  const row = (t: Task) =>
    [
      t.code,
      t.title,
      t.projectId ? (projectName.get(t.projectId) ?? t.projectId) : "",
      status[t.status] ?? t.status,
      prio[t.priority] ?? t.priority,
      t.assigneeId ? (name.get(t.assigneeId) ?? t.assigneeId) : "",
      t.dueAt ?? "",
      (t as Task & { completedAt?: string | null }).completedAt ?? "",
      t.labels.join(", "),
      t.blockedReason ?? "",
      t.createdAt,
    ]
      .map(csvCell)
      .join(",") + "\r\n";
  const header =
    "\ufeff" +
    [
      tx("work.projectsIdExportRoute.ma"),
      tx("work.projectsIdExportRoute.tieu_de"),
      tx("work.tasklist.csvProject"),
      tx("work.projectsIdExportRoute.trang_thai"),
      tx("work.projectsIdExportRoute.uu_tien"),
      tx("work.projectsIdExportRoute.nguoi_lam"),
      tx("work.projectsIdExportRoute.han_chot_utc"),
      tx("work.projectsIdExportRoute.hoan_thanh_luc_utc"),
      tx("work.projectsIdExportRoute.nhan"),
      tx("work.projectsIdExportRoute.dang_bi_chan_vi"),
      tx("work.projectsIdExportRoute.tao_luc_utc"),
    ]
      .map(csvCell)
      .join(",") +
    "\r\n";
  const enc = new TextEncoder();
  let cursor: string | null = null;
  let first = true;
  let total = 0;
  let finished = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finished) {
        controller.close();
        return;
      }
      let page: { tasks: Task[]; nextCursor: string | null };
      try {
        page = await gw<{ tasks: Task[]; nextCursor: string | null }>(
          projectId ? `/api/work/tasks?projectId=${encodeURIComponent(projectId)}` : `/api/work/tasks?scope=${scope}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        );
      } catch {
        controller.enqueue(enc.encode((first ? header : "") + csvCell(tx("work.tasklist.exportFailed")) + "\r\n"));
        controller.close();
        return;
      }
      let out = first ? header : "";
      first = false;
      for (const t of page.tasks) {
        if (!keep(t)) continue;
        if (total >= MAX_ROWS) {
          out += csvCell(tx("work.tasklist.exportTruncated", { count: MAX_ROWS })) + "\r\n";
          finished = true;
          break;
        }
        out += row(t);
        total++;
      }
      controller.enqueue(enc.encode(out));
      cursor = page.nextCursor;
      if (projectId || !cursor) finished = true;
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${tx("work.tasklist.csvFile")}-${new Date().toISOString().slice(0, 10)}.csv"`,
      "cache-control": "no-store",
    },
  });
}
