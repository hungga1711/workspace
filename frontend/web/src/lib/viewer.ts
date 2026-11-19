import "server-only";
import { cache } from "react";
import { gw } from "@/lib/gateway";

/**
 * What the signed-in person may see of other people's progress, decided like the work module does
 * (followup.ts `seesEveryone` and the reporting line): admins and owners see everyone, managers their
 * reports, everyone else only themselves. Tiến độ shows the team dashboard for "team", and the personal
 * view ("Tiến độ của tôi") otherwise. One cheap call each, cached for the request.
 */
const viewerGrants = cache(async () => (await gw<{ principal: { grants: { permission: string; scope: string }[] } }>("/api/me").catch(() => null))?.principal.grants ?? []);

/** Whether the signed-in person may create and staff teams (Admin › Nhóm & phòng ban; `member.manage`). */
export const canManageTeams = cache(async () => (await viewerGrants()).some((g) => g.permission === "member.manage" && g.scope === "WORKSPACE"));

export const progressAccess = cache(async (): Promise<"team" | "self"> => {
  const [grants, reports] = await Promise.all([viewerGrants(), gw<{ reports: unknown[] }>("/api/employee/me/reports").catch(() => ({ reports: [] as unknown[] }))]);
  const everyone = grants.some((g) => g.permission === "task.edit" && g.scope === "WORKSPACE");
  return everyone || reports.reports.length > 0 ? "team" : "self";
});
