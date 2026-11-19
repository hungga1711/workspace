-- The candidate fixes, for comparison with bench.sql.
SET work_mem = '4MB'; SET jit = off;
\set IDS 'ARRAY(SELECT ''u'' || g FROM generate_series(1,60) g)'
CREATE INDEX IF NOT EXISTS bench_msg_user_at ON ai.ai_messages (at) WHERE role = 'user';
\echo Q1fix oversight daily with partial index (at) WHERE role='user'
EXPLAIN (ANALYZE, SUMMARY) SELECT to_char(m.at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, v.source, count(*)::int
  FROM ai.ai_messages m JOIN ai.ai_conversations v ON v.id = m.conversation_id
 WHERE m.role = 'user' AND m.at > now() - interval '90 days' AND v.user_id = ANY(:IDS) GROUP BY 1, 2 ORDER BY 1;
\echo Q1alt oversight daily from conversations only (one row per conversation, started_at)
EXPLAIN (ANALYZE, SUMMARY) SELECT to_char(v.last_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, v.source, sum(v.messages)::int
  FROM ai.ai_conversations v WHERE v.last_at > now() - interval '90 days' AND v.user_id = ANY(:IDS) GROUP BY 1, 2 ORDER BY 1;
\echo Q3fix listBudgets from ai_spend_month (what the table exists for)
EXPLAIN (ANALYZE, SUMMARY) SELECT * FROM ai.ai_spend_month LIMIT 10;
\echo W2fix insights weekly buckets in one pass
EXPLAIN (ANALYZE, SUMMARY) SELECT b.bucket, coalesce(d.n, 0) AS done, coalesce(c.n, 0) AS created FROM generate_series(0, 7) AS b(bucket)
 LEFT JOIN (SELECT 8 - ceil(extract(epoch FROM now() - completed_at) / (7 * 86400))::int AS bucket, count(*) AS n FROM work.tasks WHERE status = 'done' AND completed_at >= now() - interval '8 weeks' GROUP BY 1) d ON d.bucket = b.bucket
 LEFT JOIN (SELECT 8 - ceil(extract(epoch FROM now() - created_at) / (7 * 86400))::int AS bucket, count(*) AS n FROM work.tasks WHERE created_at >= now() - interval '8 weeks' GROUP BY 1) c ON c.bucket = b.bucket ORDER BY b.bucket;
\echo W7fix move to column end with parent_id IS NULL (uses tasks_column_rank)
EXPLAIN (ANALYZE, SUMMARY) SELECT rank FROM work.tasks WHERE column_id = 'col2_p7' AND parent_id IS NULL AND id <> 't5' ORDER BY rank DESC LIMIT 1;
DROP INDEX ai.bench_msg_user_at;
