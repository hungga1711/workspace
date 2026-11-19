-- EXPLAIN ANALYZE of the request and job queries the audit flagged, in the shapes the modules run them.
-- Run twice; read the second (warm cache). bench.sh prints one line per query: time and the scan kinds used.
SET work_mem = '4MB';
SET jit = off;
\set IDS 'ARRAY(SELECT ''u'' || g FROM generate_series(1,60) g)'

\echo Q1 oversight daily 90d (all 60 people)
EXPLAIN (ANALYZE, SUMMARY) SELECT to_char(m.at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, v.source, count(*)::int
  FROM ai.ai_messages m JOIN ai.ai_conversations v ON v.id = m.conversation_id
 WHERE m.role = 'user' AND m.at > now() - interval '90 days' AND v.user_id = ANY(:IDS) GROUP BY 1, 2 ORDER BY 1;

\echo Q2 oversight weekly trend (8 weeks)
EXPLAIN (ANALYZE, SUMMARY) WITH w AS (SELECT generate_series(date_trunc('week', now()) - interval '7 weeks', date_trunc('week', now()), interval '1 week') AS week),
 e AS (SELECT v.user_id, date_trunc('week', m.at AT TIME ZONE 'UTC') AS week, 1 AS prompt, 0 AS app
         FROM ai.ai_messages m JOIN ai.ai_conversations v ON v.id = m.conversation_id
        WHERE m.role = 'user' AND v.user_id = ANY(:IDS) AND m.at > now() - interval '8 weeks'
       UNION ALL SELECT user_id, date_trunc('week', at AT TIME ZONE 'UTC'), 0, 1 FROM ai.ai_usage WHERE user_id = ANY(:IDS) AND at > now() - interval '8 weeks' AND feature NOT IN ('assistant'))
 SELECT to_char(w.week, 'YYYY-MM-DD'), coalesce(sum(e.prompt), 0)::int, coalesce(sum(e.app), 0)::int, count(DISTINCT e.user_id)::int FROM w LEFT JOIN e ON e.week = w.week GROUP BY w.week ORDER BY w.week;

\echo Q3 listBudgets (month of ai_usage_costed, 5 budgets)
EXPLAIN (ANALYZE, SUMMARY) WITH m AS (SELECT user_id, department_id, input_tokens + output_tokens AS tokens, coalesce(cost_usd, 0) AS usd FROM ai.ai_usage_costed WHERE at >= date_trunc('month', now()))
 SELECT b.scope, b.scope_id,
   coalesce((SELECT sum(tokens) FROM m WHERE b.scope = 'workspace' OR (b.scope = 'person' AND m.user_id = b.scope_id) OR (b.scope = 'department' AND m.department_id = b.scope_id)), 0) AS tokens,
   coalesce((SELECT sum(usd) FROM m WHERE b.scope = 'workspace' OR (b.scope = 'person' AND m.user_id = b.scope_id) OR (b.scope = 'department' AND m.department_id = b.scope_id)), 0) AS usd
 FROM ai.ai_budgets b ;

\echo Q4 agent budget check (hot path, month sum for one agent)
EXPLAIN (ANALYZE, SUMMARY) SELECT coalesce(sum(input_tokens + output_tokens), 0) FROM ai.ai_usage WHERE agent_id = 'agent1' AND at >= date_trunc('month', now());

\echo Q5 ai_prune_expired candidate select (hourly)
EXPLAIN (ANALYZE, SUMMARY) SELECT v.id FROM ai.ai_conversations v WHERE v.last_at < now() - make_interval(days => coalesce((SELECT retention_days FROM ai.ai_policy), 180)) LIMIT 5000;

\echo Q6 topic batch due check (hourly)
EXPLAIN (ANALYZE, SUMMARY) SELECT EXISTS (SELECT 1 FROM ai.ai_conversations v WHERE v.topic_by = 'keywords' AND v.last_at > now() - interval '2 hours');

\echo Q7 prompt library search as superuser
EXPLAIN (ANALYZE, SUMMARY) SELECT id, title, uses FROM ai.ai_prompt_library WHERE tsv @@ to_tsquery('simple', 'invoice') ORDER BY uses DESC, created_at DESC LIMIT 50;

\echo Q7b prompt library search as the ai role
SET ROLE workspace_ai;
EXPLAIN (ANALYZE, SUMMARY) SELECT id, title, uses FROM ai.ai_prompt_library WHERE tsv @@ to_tsquery('simple', 'invoice') ORDER BY uses DESC, created_at DESC LIMIT 50;
EXPLAIN (ANALYZE, SUMMARY) SELECT count(*) FROM ai.ai_prompt_library;
RESET ROLE;

\echo Q8 me export: all of one person's messages
EXPLAIN (ANALYZE, SUMMARY) SELECT m.id, m.content FROM ai.ai_messages m JOIN ai.ai_conversations v ON v.id = m.conversation_id WHERE v.user_id = 'u7';

\echo Q9 purge monitoring: ids of all non-company conversations
EXPLAIN (ANALYZE, SUMMARY) SELECT id FROM ai.ai_conversations WHERE source <> 'company';

\echo W1 insights totals (workspace-wide count filters)
EXPLAIN (ANALYZE, SUMMARY) SELECT count(*) FILTER (WHERE status NOT IN ('done','cancelled')) AS open, count(*) FILTER (WHERE status NOT IN ('done','cancelled') AND due_at < now()) AS overdue,
  count(*) FILTER (WHERE status NOT IN ('done','cancelled') AND blocked_reason IS NOT NULL) AS blocked FROM work.tasks;

\echo W2 insights 8 weekly buckets (16 correlated counts)
EXPLAIN (ANALYZE, SUMMARY) SELECT b.bucket,
  (SELECT count(*) FROM work.tasks WHERE completed_at >= now() - make_interval(days => 7 * (8 - b.bucket)) AND completed_at < now() - make_interval(days => 7 * (7 - b.bucket))) AS done,
  (SELECT count(*) FROM work.tasks WHERE created_at >= now() - make_interval(days => 7 * (8 - b.bucket)) AND created_at < now() - make_interval(days => 7 * (7 - b.bucket))) AS created
 FROM generate_series(0, 7) AS b(bucket) ORDER BY b.bucket;

\echo W3 insights workload per person
EXPLAIN (ANALYZE, SUMMARY) SELECT assignee_id, count(*) FILTER (WHERE status NOT IN ('done','cancelled')) AS open, count(*) FILTER (WHERE status NOT IN ('done','cancelled') AND due_at < now()) AS overdue,
  count(*) FILTER (WHERE status = 'done' AND completed_at > now() - interval '7 days') AS done7
 FROM work.tasks WHERE assignee_id IS NOT NULL GROUP BY assignee_id ORDER BY overdue DESC, open DESC LIMIT 50;

\echo W4 my tasks page (assignee, sort by due)
EXPLAIN (ANALYZE, SUMMARY) SELECT id, title FROM work.tasks WHERE (assignee_id = 'u7' OR (owner_id = 'u7' AND assignee_id IS NULL)) AND status NOT IN ('done','cancelled') ORDER BY coalesce(due_at, 'infinity'), id LIMIT 50;

\echo W5 project list page (200, sort by due, done included)
EXPLAIN (ANALYZE, SUMMARY) SELECT id, title FROM work.tasks WHERE project_id = 'p7' AND parent_id IS NULL ORDER BY coalesce(due_at, 'infinity'), id LIMIT 200;

\echo W6 board: window count per column for one project
EXPLAIN (ANALYZE, SUMMARY) SELECT * FROM (SELECT id, column_id, row_number() OVER (PARTITION BY column_id ORDER BY rank) AS rn, count(*) OVER (PARTITION BY column_id) AS n FROM work.tasks WHERE project_id = 'p7' AND parent_id IS NULL AND status <> 'cancelled') x WHERE rn <= 50;

\echo W7 move to column end (no parent_id predicate -> partial index unusable)
EXPLAIN (ANALYZE, SUMMARY) SELECT rank FROM work.tasks WHERE column_id = 'col2_p7' AND id <> 't5' ORDER BY rank DESC LIMIT 1;

\echo W8 check-in prompt shape (every 30 min)
EXPLAIN (ANALYZE, SUMMARY) SELECT id FROM work.tasks WHERE status IN ('in_progress','review') AND coalesce(checkin_at, updated_at) < now() - interval '3 days' ORDER BY coalesce(due_at, 'infinity') LIMIT 1000;

\echo W9 task suggestion full text for one person
EXPLAIN (ANALYZE, SUMMARY) SELECT id, title FROM work.tasks WHERE (assignee_id = 'u7' OR owner_id = 'u7') AND status <> 'cancelled'
  AND to_tsvector('simple', public.unaccent(lower(title))) @@ to_tsquery('simple', 'invoice | export') ORDER BY updated_at DESC LIMIT 3;

\echo C1 channel history page
EXPLAIN (ANALYZE, SUMMARY) SELECT id, body FROM chat.messages WHERE channel_id = 'ch7' AND thread_root_id IS NULL ORDER BY seq DESC LIMIT 50;

\echo C2 channel list: mention count since seq 0 in one channel (new member)
EXPLAIN (ANALYZE, SUMMARY) SELECT count(*) FROM chat.messages m WHERE m.channel_id = 'ch20' AND m.seq > 0 AND m.mentions @> ARRAY['u1']::text[];

\echo C3 mentions page for u1 (no cursor)
EXPLAIN (ANALYZE, SUMMARY) SELECT id FROM chat.messages WHERE mentions @> ARRAY['u1']::text[] ORDER BY created_at DESC LIMIT 100;

\echo S1 search_candidates (common word)
EXPLAIN (ANALYZE, SUMMARY) SELECT d.entity_type, d.entity_id FROM search.search_documents d WHERE d.tsv @@ to_tsquery('simple', 'customer') AND (d.container_id = ANY(ARRAY(SELECT 'p' || g FROM generate_series(1,50) g)) OR d.acl_users && ARRAY['u1']) ORDER BY d.updated_at DESC LIMIT 1000;

\echo S2 search_candidates (rare word)
EXPLAIN (ANALYZE, SUMMARY) SELECT d.entity_type, d.entity_id FROM search.search_documents d WHERE d.tsv @@ to_tsquery('simple', 'onboarding & flow') AND (d.container_id = ANY(ARRAY(SELECT 'p' || g FROM generate_series(1,50) g)) OR d.acl_users && ARRAY['u1']) ORDER BY d.updated_at DESC LIMIT 1000;

\echo N1 badge count shape (notifications unread action for one user) -- no notifications loaded, plan only
EXPLAIN (ANALYZE, SUMMARY) SELECT count(*) FROM home.notifications WHERE user_id = 'x' AND grp = 'action' AND read_at IS NULL;
