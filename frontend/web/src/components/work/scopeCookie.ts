// A plain module (not "use client"): the server page reads the cookie, `ScopeCrumb` writes it.
export const SCOPE_COOKIE = "wos_scope";

export type RememberedScope = "mine" | "owned" | "projects" | { project: string };

const ID = /^[A-Za-z0-9-]{1,64}$/;

/** `<userId>.<mine|owned|projects|p:<projectId>>` */
export function scopeCookieValue(userId: string, s: RememberedScope): string {
  return `${userId}.${typeof s === "string" ? s : `p:${s.project}`}`;
}

export function parseScopeCookie(raw: string | undefined): { userId: string; scope: RememberedScope } | null {
  if (!raw) return null;
  const dot = raw.indexOf(".");
  if (dot < 1) return null;
  const userId = raw.slice(0, dot);
  const v = raw.slice(dot + 1);
  if (!ID.test(userId)) return null;
  if (v === "mine" || v === "owned" || v === "projects") return { userId, scope: v };
  if (v.startsWith("p:") && ID.test(v.slice(2))) return { userId, scope: { project: v.slice(2) } };
  return null;
}
