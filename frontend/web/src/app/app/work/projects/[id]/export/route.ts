import { gw, GatewayError } from "@/lib/gateway";
import type { T } from "@/lib/i18n/core";
import { getT } from "@/lib/i18n/server";
import { csvFile, csvResponse } from "@/lib/csv";
import type { Task } from "@/components/work/types";

const STATUS = (tx: T): Record<string, string> => ({
  todo: tx("work.projectsIdExportRoute.can_lam"),
  in_progress: tx("work.projectsIdExportRoute.dang_lam"),
  review: tx("work.projectsIdExportRoute.cho_duyet"),
  done: "Xong",
  cancelled: tx("work.projectsIdExportRoute.da_huy"),
});
const PRIORITY = (tx: T): Record<string, string> => ({
  low: tx("work.projectsIdExportRoute.thap"),
  medium: tx("work.projectsIdExportRoute.vua"),
  high: "Cao",
  urgent: tx("work.projectsIdExportRoute.khan"),
});

/** A project's tasks as CSV for reporting (only the tasks the viewer can read, as on the board). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const tx = await getT();
  const { id } = await params;
  try {
    const [board, members, project, teams, defs] = await Promise.all([
      gw<{ project: { code: string; name: string }; columns: { name: string; tasks: Task[] }[] }>(`/api/work/projects/${id}/board?limit=500`),
      gw<{ members: { userId: string; displayName: string; email: string }[] }>("/api/identity/members").catch(() => ({ members: [] })),
      gw<{ teamId?: string | null }>(`/api/work/projects/${id}`).catch(() => ({ teamId: null })),
      gw<{ teams: { id: string; name: string }[] }>("/api/identity/teams").catch(() => ({ teams: [] })),
      gw<{ fields: { entity: string; key: string; label: string }[] }>("/api/work/custom-fields").catch(() => ({ fields: [] })),
    ]);
    const name = new Map(members.members.map((m) => [m.userId, m.displayName]));
    const team = teams.teams.find((t) => t.id === project.teamId)?.name ?? "";
    // The workspace's own task fields come after the fixed columns, one column each, in the admin's order.
    const custom = defs.fields.filter((f) => f.entity === "task");
    const customValue = (t: Task, key: string) => {
      const v = (t.customFields ?? {})[key];
      return v === null || v === undefined ? "" : Array.isArray(v) ? v.join(", ") : String(v);
    };
    const rows = board.columns.flatMap((col) =>
      col.tasks.map((t) => [
        t.code,
        t.title,
        col.name,
        STATUS(tx)[t.status] ?? t.status,
        PRIORITY(tx)[t.priority] ?? t.priority,
        t.assigneeId ? (name.get(t.assigneeId) ?? t.assigneeId) : "",
        t.dueAt ?? "",
        (t as Task & { completedAt?: string | null }).completedAt ?? "",
        t.labels.join(", "),
        t.blockedReason ?? "",
        t.createdAt,
        team,
        ...custom.map((f) => customValue(t, f.key)),
      ]),
    );
    const header = [
      tx("work.projectsIdExportRoute.ma"),
      tx("work.projectsIdExportRoute.tieu_de"),
      tx("work.projectsIdExportRoute.cot"),
      tx("work.projectsIdExportRoute.trang_thai"),
      tx("work.projectsIdExportRoute.uu_tien"),
      tx("work.projectsIdExportRoute.nguoi_lam"),
      tx("work.projectsIdExportRoute.han_chot_utc"),
      tx("work.projectsIdExportRoute.hoan_thanh_luc_utc"),
      tx("work.projectsIdExportRoute.nhan"),
      tx("work.projectsIdExportRoute.dang_bi_chan_vi"),
      tx("work.projectsIdExportRoute.tao_luc_utc"),
      tx("work.projectsIdExportRoute.team"),
      ...custom.map((f) => f.label),
    ];
    // Data leaving the app goes on the audit trail (Admin › Nhật ký); a failed record never blocks the download.
    await gw("/api/platform/audit/record", {
      method: "POST",
      body: { action: "work.project.exported", targetType: "project", targetId: id, targetLabel: `${board.project.code} · ${board.project.name}`, meta: { tasks: rows.length } },
    }).catch(() => undefined);
    return csvResponse(csvFile(header, rows), `${board.project.code}-${tx("work.tasklist.csvFile")}-${new Date().toISOString().slice(0, 10)}.csv`);
  } catch (e) {
    if (e instanceof GatewayError && (e.status === 404 || e.status === 403)) return new Response(tx("work.projectsIdExportRoute.khong_tim_thay_du"), { status: e.status });
    throw e;
  }
}
