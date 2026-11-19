import "server-only";
import { readSession } from "@/lib/session";
import { SCOPE_COOKIE, parseScopeCookie, type RememberedScope } from "@/components/work/scopeCookie";

export { SCOPE_COOKIE };

/**
 * The Việc scope this person used last (written by `ScopeCrumb`), or "mine". The cookie carries the user id, so
 * a second account signed in on the same browser does not inherit someone else's project.
 */
export async function rememberedScope(raw: string | undefined): Promise<RememberedScope> {
  const parsed = parseScopeCookie(raw);
  if (!parsed) return "mine";
  const session = await readSession();
  return session && session.userId === parsed.userId ? parsed.scope : "mine";
}

/** The search params a remembered scope stands for (the same ones `ScopeCrumb` links to). */
export function scopeParams(s: RememberedScope): { scope?: string; view?: string; project?: string } {
  if (s === "mine") return { scope: "assigned" };
  if (s === "owned") return { scope: "owned" };
  if (s === "projects") return { view: "projects" };
  return { project: s.project };
}
