import { authorize, type Principal } from "@workspace/shared";

/**
 * Who sees and changes what in the prompt library, kept apart from SQL so the rules are tested alone.
 *
 * - Company prompts: set up by holders of ai.prompt.manage. WORKSPACE scope (Owner, Admin, and AI admins) manages
 *   every one; DEPARTMENT scope (Manager by default) manages only the ones meant for their own department alone. A live
 *   company prompt reaches everyone (empty audience) or the departments listed. A proposed or declined one is seen
 *   only by its proposer and those who may manage it.
 * - Personal prompts: the author's. Private, the author's department, or everyone. The author edits and deletes; an
 *   AI admin may also remove one (moderation), never edit it.
 */
export type Manage = "workspace" | "department" | null;

export interface PromptRow {
  level: "company" | "personal";
  visibility: "private" | "department" | "everyone";
  status: "live" | "proposed" | "declined";
  author_id: string;
  department_id: string | null;
  audience: string[];
}

/** How far the caller may manage company prompts. AI policy admins always may, company-wide. */
export function manageScope(p: Principal): Manage {
  if (authorize(p, "ai.policy.manage").allowed) return "workspace";
  let best: Manage = null;
  for (const g of p.grants) {
    if (g.permission !== "ai.prompt.manage") continue;
    if (g.scope === "WORKSPACE" || g.scope === "PLATFORM") return "workspace";
    if (g.scope === "DEPARTMENT" && p.departmentId) best = "department";
  }
  return best;
}

/** May the caller publish or change a company prompt meant for this audience? */
export function canManageAudience(p: Principal, manage: Manage, audience: readonly string[]): boolean {
  if (manage === "workspace") return true;
  return manage === "department" && audience.length === 1 && audience[0] === p.departmentId;
}

export function canSee(p: Principal, manage: Manage, r: PromptRow): boolean {
  if (r.author_id === p.id) return true;
  if (r.level === "company") {
    if (r.status !== "live") return canManageAudience(p, manage, r.audience);
    return r.audience.length === 0 || (!!p.departmentId && r.audience.includes(p.departmentId)) || manage === "workspace";
  }
  if (r.visibility === "everyone") return true;
  return r.visibility === "department" && !!r.department_id && r.department_id === p.departmentId;
}

export function canEdit(p: Principal, manage: Manage, r: PromptRow): boolean {
  if (r.level === "personal") return r.author_id === p.id;
  // A proposer may still reword their proposal while it waits; once live it is the company's.
  if (r.status === "proposed" && r.author_id === p.id) return true;
  return canManageAudience(p, manage, r.audience);
}

export function canDelete(p: Principal, manage: Manage, r: PromptRow): boolean {
  if (r.level === "personal") return r.author_id === p.id || authorize(p, "ai.policy.manage").allowed;
  return canEdit(p, manage, r);
}

/** The caller as a row the filters below read ($1 id, $2 department or null, $3 company-wide manager). */
export const ME_SQL = "WITH me AS (SELECT $1::text AS uid, $2::text AS udept, $3::boolean AS uws)";

/** The same visibility rule as SQL, over `me`. Proposals are left out; the review tab and "Của tôi" list them. */
export const VISIBLE_SQL = `(
  (level = 'company' AND status = 'live' AND (cardinality(audience) = 0 OR me.udept = ANY(audience) OR me.uws))
  OR (level = 'personal' AND (author_id = me.uid OR visibility = 'everyone' OR (visibility = 'department' AND department_id = me.udept)))
)`;
