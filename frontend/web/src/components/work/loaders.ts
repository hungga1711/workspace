import "server-only";
import { aiStatus } from "@/lib/ai";
import { notFound } from "next/navigation";
import { gw, gwOnce, GatewayError } from "@/lib/gateway";
import { readPage } from "@/lib/page-read";
import type { TaskDetail } from "@/app/app/work/tasks/[id]/page";
import type { ApprovalData } from "./ApprovalDetail";
import type { MeetingDetail } from "./MeetingView";
import type { FieldDef, Project } from "./types";

/** 404 from the backend becomes the not-found page; anything else is an error. */
export async function or404<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof GatewayError && e.status === 404) notFound();
    throw e;
  }
}

/**
 * A route's `[id]` as one safe path segment for the API: an id or a code (`T-041`), whether Next handed it over
 * encoded or not (codes follow the workspace's own format and may hold spaces or slashes).
 */
export function refParam(raw: string): string {
  let v = raw;
  try {
    v = decodeURIComponent(raw);
  } catch {
    /* already decoded and holding a lone % */
  }
  return encodeURIComponent(v);
}

/**
 * What the task page and the task view over a list both need; `id` may be the task's code. A failed read comes
 * back as `failed` (lib/page-read.ts) so the page shows a retry or "no access" instead of the error screen.
 */
export function loadTask(id: string) {
  return readPage(
    Promise.all([
      gwOnce<TaskDetail>(`/api/work/tasks/${refParam(id)}`),
      // The project picker's list: the task still opens without it.
      gw<{ projects: Project[] }>("/api/work/projects").catch(() => ({ projects: [] as Project[] })),
      gw<{ fields: FieldDef[] }>("/api/work/custom-fields").catch(() => ({ fields: [] as FieldDef[] })),
      aiStatus(),
    ]).then(([detail, projects, fields, ai]) => ({
      detail,
      projects: projects.projects,
      fields: fields.fields.filter((f) => f.entity === "task"),
      aiEnabled: ai.configured,
    })),
  );
}

/** A request by its id or its code (`YC-007`). */
export function loadApproval(id: string) {
  return or404(gwOnce<ApprovalData>(`/api/work/approvals/${refParam(id)}`));
}

/** A meeting by its id or its code (`H-012`, `H-012-3` in a series). */
export function loadMeeting(id: string) {
  return or404(
    Promise.all([
      gwOnce<MeetingDetail>(`/api/work/meetings/${refParam(id)}`),
      gw<{ projects: Project[] }>("/api/work/projects").catch(() => ({ projects: [] as Project[] })),
      aiStatus(),
    ]).then(([detail, projects, ai]) => ({
      detail,
      projects: projects.projects,
      aiEnabled: ai.configured,
    })),
  );
}
