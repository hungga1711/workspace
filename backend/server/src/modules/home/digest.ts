import type { Pool } from "pg";
import { newId, runWithContext, withTransaction } from "@workspace/shared";
import { emailLayout, logger, type Mailer } from "@workspace/service-kit";
import { textsFor } from "./texts.js";

/** The Follow-up view of a manager's team, read as that manager (null when they have no reports). */
export type TeamLoader = (userId: string) => Promise<TeamSummary | null>;
/** My own week (the Follow-up row my manager sees), read as me. */
export type MeLoader = (userId: string) => Promise<{ done7: number; inProgress: number; overdue: number } | null>;
export interface TeamSummary {
  totals: { overdue: number; atRisk?: number; stale: number; blocked: number; done7: number };
  people: {
    displayName: string;
    late: { title: string }[];
    tasks: { title: string; stale?: boolean; overdue?: boolean; atRisk?: boolean; blockedReason: string | null; status: string }[];
  }[];
}

const isMonday = (tz: string) => new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: tz }).format(new Date()) === "Mon";

/**
 * Daily email digest (fallback when push is off or unavailable): what needs the person today, once per local day
 * after their chosen hour, only when there is something to say.
 */
export async function sendDigests(
  pool: Pool,
  mailer: Mailer,
  appUrl: string,
  limit = 500,
  loadTeam?: TeamLoader,
  monday: (tz: string) => boolean = isMonday,
  loadMe?: MeLoader,
): Promise<number> {
  const due = (await pool.query<{ user_id: string; timezone: string; email: string }>("SELECT * FROM digest_candidates($1)", [limit])).rows;
  let sent = 0;
  for (const u of due) {
    await runWithContext({ actorId: "service:digest", requestId: newId() }, () =>
      withTransaction(pool, async (c) => {
        const items = (
          await c.query<{ kind: string; title: string; subtitle: string; url: string }>(
            `SELECT kind, title, subtitle, url FROM home_items WHERE user_id = $1 AND needs_action AND resolved_at IS NULL
          ORDER BY CASE kind WHEN 'approval' THEN 0 WHEN 'decision' THEN 1 WHEN 'blocker' THEN 2 WHEN 'mention' THEN 3 WHEN 'dm' THEN 4 ELSE 5 END, due_at NULLS LAST LIMIT 10`,
            [u.user_id],
          )
        ).rows;
        const meetings = (
          await c.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM home_items WHERE user_id = $1 AND kind = 'meeting' AND resolved_at IS NULL AND (starts_at AT TIME ZONE $2)::date = (now() AT TIME ZONE $2)::date`,
            [u.user_id, u.timezone],
          )
        ).rows[0]!.n;
        await c.query("UPDATE user_prefs SET last_digest_date = (now() AT TIME ZONE $2)::date WHERE user_id = $1", [u.user_id, u.timezone]);
        // Mondays, for managers: where their team stands (the Follow-up view, read as them).
        const team = loadTeam && monday(u.timezone) ? await loadTeam(u.user_id).catch(() => null) : null;
        const hasTeam = !!team && team.people.length > 0;
        if (items.length === 0 && meetings === 0 && !hasTeam) return; // nothing to say: no email
        const all = await textsFor(c, u.user_id);
        const t = all.digest;
        const lines = items.map((i) => `• ${t.kind[i.kind] ?? i.kind}: ${i.title.replace(/<@[\w:-]+>/g, "@…")}${i.subtitle ? ` (${i.subtitle})` : ""}`);
        const parts = items.length || meetings ? [`${t.body(items.length, meetings)}\n\n${lines.join("\n")}`] : [];
        // Mondays: one line on my own last week, first, when there was any work (never a reason to send by itself).
        const mine = parts.length || hasTeam ? (loadMe && monday(u.timezone) ? await loadMe(u.user_id).catch(() => null) : null) : null;
        if (mine && mine.done7 + mine.inProgress + mine.overdue > 0) parts.unshift(t.myWeek(mine.done7, mine.inProgress, mine.overdue));
        if (hasTeam) {
          const watch = team.people
            .flatMap((p) =>
              p.tasks
                .filter((x) => x.status !== "done" && (x.overdue || x.atRisk || x.stale || x.blockedReason))
                .map((x) => `• ${p.displayName}: ${x.title} (${t.teamWhy[x.overdue ? "late" : x.atRisk ? "risk" : x.blockedReason ? "blocked" : "stale"]})`),
            )
            .slice(0, 8);
          parts.push(
            `${t.teamHeading}\n${t.team(team.totals.overdue, team.totals.stale, team.totals.blocked, team.totals.done7, team.totals.atRisk ?? 0)}${watch.length ? `\n\n${watch.join("\n")}` : ""}`,
          );
        }
        const body = parts.join("\n\n");
        const onlyTeam = hasTeam && items.length === 0 && meetings === 0;
        const { html, text } = emailLayout(
          onlyTeam ? t.teamHeading : t.heading,
          body,
          onlyTeam ? { label: t.teamOpen, url: `${appUrl}/app/ai/progress` } : { label: t.open, url: `${appUrl}/app/home` },
          all.lang,
        );
        try {
          await mailer.send({ to: u.email, subject: onlyTeam ? t.teamSubject(team.totals.overdue) : t.subject(items.length, meetings), html, text });
          sent++;
        } catch (err) {
          logger.warn({ err }, "digest email failed");
        }
      }),
    );
  }
  return sent;
}

/** Categories a person can mute; each maps to notification kinds. "action" approvals cannot be muted. */
export const MUTE_GROUPS: Record<string, string[]> = {
  mention: ["mention", "task.mention"],
  dm: [],
  task: ["task.assigned", "task.completed", "task.commented", "task.due"],
  meeting: ["meeting.invited", "meeting.updated"],
  decision: ["decision.proposed", "decision.decided"],
  leave: ["leave.decided"],
  doc: ["doc.updated", "doc.commented"],
};
