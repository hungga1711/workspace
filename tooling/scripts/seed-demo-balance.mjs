/**
 * How late the demo company runs. Seeded due dates are fixed offsets, so after a while most open work reads overdue
 * and the owner's views (Progress, Today, projects) show a company that is all red. This keeps lateness a story:
 * two projects past their date and one at risk, each with a status update that says why, about a dozen late tasks
 * (blocked ones first), and every other open task due in the next weeks.
 *
 * Dates are taken from the demo clock's anchor (the moment the data is "as of"), so `platform.demo_refresh()` moves
 * them forward with everything else. Idempotent: running it again changes nothing that is already in shape.
 */
export const LATE_PROJECTS = ["Marketing the open source launch", "Roadmap: phases after v1.0"];
export const AT_RISK_PROJECT = "Open source v1.0: web and desktop";

const UPDATES = [
  [
    "Marketing the open source launch",
    "off_track",
    "The public demo is blocked on the signed GHCR image, and the launch post is still waiting for a full Ship a change / launch-content run. New target is a week out once the image ships.",
  ],
  [
    "Roadmap: phases after v1.0",
    "off_track",
    "Code signing for desktop builds is still an open maintainer decision, so phase 2 (mobile) cannot be scheduled. We keep collecting issue requests until that lands.",
  ],
  [
    "Open source v1.0: web and desktop",
    "at_risk",
    "Due in five days. Playwright still has failures on the old Home layout, and signed desktop updates wait on the code-signing decision. If review slips past 48 hours we miss the date.",
  ],
];

const q = (s) => `'${s.replace(/'/g, "''")}'`;

export const balanceSql = `BEGIN;
CREATE TEMP TABLE bal ON COMMIT DROP AS SELECT coalesce((SELECT anchor FROM platform.demo_clock), now()) AS t0;

-- Two projects past their date, one due in five days.
UPDATE work.projects SET due_at = (SELECT t0 FROM bal) - interval '6 days' WHERE name = ${q(LATE_PROJECTS[0])} AND status = 'active';
UPDATE work.projects SET due_at = (SELECT t0 FROM bal) - interval '2 days' WHERE name = ${q(LATE_PROJECTS[1])} AND status = 'active';
UPDATE work.projects SET due_at = (SELECT t0 FROM bal) + interval '5 days' WHERE name = ${q(AT_RISK_PROJECT)} AND status = 'active';

-- Open top-level tasks that are overdue. Kept late: up to four in each late project, two in the at-risk one, and the
-- most overdue blocked task of any other project. Everything else moves to the next two to three weeks.
CREATE TEMP TABLE od ON COMMIT DROP AS
  SELECT t.id, p.name AS pname, t.blocked_reason, t.due_at,
         row_number() OVER (PARTITION BY t.project_id ORDER BY (t.blocked_reason IS NOT NULL) DESC, t.due_at DESC, t.id) AS rn
    FROM work.tasks t JOIN work.projects p ON p.id = t.project_id
   WHERE t.parent_id IS NULL AND t.status NOT IN ('done', 'cancelled') AND t.due_at < (SELECT t0 FROM bal);
CREATE TEMP TABLE keep ON COMMIT DROP AS
  SELECT id, due_at FROM od
   WHERE (pname IN (${LATE_PROJECTS.map(q).join(", ")}) AND rn <= 4)
      OR (pname = ${q(AT_RISK_PROJECT)} AND rn <= 2)
      OR (pname NOT IN (${[...LATE_PROJECTS, AT_RISK_PROJECT].map(q).join(", ")}) AND blocked_reason IS NOT NULL AND rn = 1);

-- How far each task moves: kept ones end up one to ten days late, the rest due in two to nineteen days.
CREATE TEMP TABLE moved ON COMMIT DROP AS
  SELECT od.id,
         CASE WHEN k.id IS NOT NULL
              THEN CASE WHEN od.due_at < (SELECT t0 FROM bal) - interval '10 days'
                        THEN ((SELECT t0 FROM bal) - make_interval(days => 1 + (abs(hashtext(od.id)) % 10))) - od.due_at
                        ELSE interval '0' END
              ELSE ((SELECT t0 FROM bal) + make_interval(days => 2 + (abs(hashtext(od.id)) % 18))) - od.due_at
         END AS delta
    FROM od LEFT JOIN keep k ON k.id = od.id;
-- Whole days keep each due time at its 17:00.
UPDATE moved SET delta = make_interval(days => ceil(extract(epoch FROM delta) / 86400)::int) WHERE delta <> interval '0';
UPDATE work.tasks t SET due_at = t.due_at + m.delta FROM moved m WHERE t.id = m.id AND m.delta <> interval '0';
UPDATE work.tasks t SET due_at = t.due_at + m.delta FROM moved m WHERE t.parent_id = m.id AND t.due_at IS NOT NULL AND m.delta <> interval '0';

-- Why the late projects are late, from their owners; dated a few days before "now" so the refresh moves them too.
INSERT INTO work.project_updates (id, project_id, author_id, health, body, suggested, created_at)
SELECT 'demo-update-' || p.code, p.id, p.owner_id, u.health, u.body, false, (SELECT t0 FROM bal) - interval '2 days'
  FROM (VALUES ${UPDATES.map(([n, h, b]) => `(${q(n)}, ${q(h)}, ${q(b)})`).join(",\n               ")}) AS u(name, health, body)
  JOIN work.projects p ON p.name = u.name AND p.status = 'active'
ON CONFLICT (id) DO NOTHING;
COMMIT;`;
