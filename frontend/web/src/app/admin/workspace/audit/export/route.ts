import { gw, GatewayError } from "@/lib/gateway";
import { getT } from "@/lib/i18n/server";
import { actionLabel, filterFromParams, trailQuery, type TrailEntry, type TrailPage } from "@/components/admin/audit";
import { csvFile, csvResponse } from "@/lib/csv";

/** Up to this many rows per export; a longer period should be exported in parts. */
const MAX_ROWS = 20_000;
const PAGE = 1000;

/** Audit export: the screen's filter, the whole trail it matches, as CSV that opens correctly in Excel (UTF-8 BOM). */
export async function GET(req: Request) {
  const tx = await getT();
  const filter = filterFromParams(Object.fromEntries(new URL(req.url).searchParams));
  try {
    const out: TrailEntry[] = [];
    let cursor: string | null = null;
    // The first page is recorded on the trail as an export (purpose=export); the next pages carry the cursor.
    do {
      const q = trailQuery(filter);
      q.set("limit", String(PAGE));
      q.set("purpose", "export");
      if (cursor) q.set("cursor", cursor);
      const page: TrailPage = await gw<TrailPage>(`/api/platform/audit?${q}`);
      out.push(...page.entries);
      cursor = page.next;
    } while (cursor && out.length < MAX_ROWS);
    const m = await gw<{ members: { userId: string; displayName: string; email: string }[] }>("/api/identity/members").catch(() => ({ members: [] }));
    const people = new Map(m.members.map((x) => [x.userId, x]));
    const who = (e: TrailEntry) => {
      const p = e.actorType === "user" ? people.get(e.actorId) : undefined;
      return p ? `${p.displayName} <${p.email}>` : e.actorId;
    };
    const rows = out
      .slice(0, MAX_ROWS)
      .map((e) => [
        e.at,
        who(e),
        e.actorType,
        e.via ?? "",
        e.action,
        actionLabel(tx, e.action),
        e.targetType,
        e.targetId,
        e.targetLabel ?? "",
        e.outcome,
        e.ip ?? "",
        e.requestId ?? "",
        Object.keys(e.changes ?? {}).length ? JSON.stringify(e.changes) : "",
        Object.keys(e.meta ?? {}).length ? JSON.stringify(e.meta) : "",
      ]);
    const header = [
      tx("admin.auditExportRoute.thoi_gian_utc"),
      tx("admin.auditExportRoute.nguoi_thuc_hien"),
      tx("admin.trail.csv_actorType"),
      tx("admin.trail.via"),
      tx("admin.auditExportRoute.ma_hanh_dong"),
      tx("admin.auditExportRoute.hanh_dong"),
      tx("admin.auditExportRoute.doi_tuong"),
      tx("admin.auditExportRoute.ma_doi_tuong"),
      tx("admin.trail.csv_targetLabel"),
      tx("admin.trail.outcome"),
      tx("admin.trail.ip"),
      tx("admin.trail.request"),
      tx("admin.trail.changes"),
      tx("admin.auditExportRoute.chi_tiet"),
    ];
    return csvResponse(csvFile(header, rows), `nhat-ky-hoat-dong-${new Date().toISOString().slice(0, 10)}.csv`);
  } catch (e) {
    if (e instanceof GatewayError && e.status === 403) return new Response(tx("admin.auditExportRoute.ban_khong_co_quyen"), { status: 403 });
    throw e;
  }
}
