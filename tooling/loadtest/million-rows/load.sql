\timing on
-- Synthetic rows for the "million rows" benchmark (tooling/loadtest/million-rows/README.md).
-- Run as the postgres superuser against the benchmark's own database (workspace_bench), never the development one:
-- an installation holds one workspace, so the rows cannot be told apart from real ones. Dropping the database
-- removes them. Needs about 3 GB of free disk in the Postgres volume.
SET work_mem = '64MB';
INSERT INTO ai.ai_policy (retention_days) VALUES (180) ON CONFLICT DO NOTHING;
INSERT INTO ai.ai_model_prices (provider, model, input_per_mtok, output_per_mtok, updated_by, updated_at)
  VALUES ('openai', 'gpt-4o-mini', 0.15, 0.6, 'bench', now()) ON CONFLICT DO NOTHING;
INSERT INTO ai.ai_budgets (scope, scope_id, monthly_tokens, monthly_usd, updated_by, updated_at) VALUES
  ('workspace', '', 100000000, 500, 'bench', now()), ('department', 'd1', 10000000, 50, 'bench', now()),
  ('person', 'u1', 1000000, 5, 'bench', now()), ('person', 'u2', 1000000, 5, 'bench', now()), ('person', 'u3', 1000000, 5, 'bench', now())
  ON CONFLICT DO NOTHING;

-- 200k conversations over 180 days, 60 people, 3 sources, 8 topics.
INSERT INTO ai.ai_conversations (id, user_id, source, external_key, title, topic, messages, started_at, last_at, helpful, topic_by)
SELECT 'c' || g, 'u' || (1 + g % 60), (ARRAY['company','chatgpt','claude'])[1 + g % 3], 'k' || g, 'Conversation ' || g,
       (ARRAY['code','writing','data','research','email','meeting','support','other'])[1 + g % 8], 5,
       now() - (random() * 180) * interval '1 day', now() - (random() * 180) * interval '1 day',
       CASE WHEN g % 4 = 0 THEN 'yes' WHEN g % 9 = 0 THEN 'no' WHEN g % 13 = 0 THEN 'partly' END,
       CASE WHEN g % 10 = 0 THEN 'keywords' ELSE 'model' END
FROM generate_series(1, 200000) g;
UPDATE ai.ai_conversations SET last_at = greatest(last_at, started_at);

-- 1M messages: 3 user + 2 assistant per conversation, ~150 characters each.
INSERT INTO ai.ai_messages (id, conversation_id, role, content, at)
SELECT 'm' || g, 'c' || (1 + (g - 1) / 5), CASE WHEN (g - 1) % 5 IN (0, 2, 4) THEN 'user' ELSE 'assistant' END,
       'Please help me with ' || md5(g::text) || ' and summarise the quarterly report for the customer ' || md5((g * 7)::text) || ' before Friday meeting',
       v.started_at + ((g - 1) % 5) * interval '1 minute'
FROM generate_series(1, 1000000) g JOIN ai.ai_conversations v ON v.id = 'c' || (1 + (g - 1) / 5);

-- 1M usage rows over 180 days, 60 people, 6 departments.
INSERT INTO ai.ai_usage (id, user_id, agent_id, feature, model, input_tokens, output_tokens, at, provider, department_id, subject_type, subject_id)
SELECT 'g' || g, 'u' || (1 + g % 60), CASE WHEN g % 50 = 0 THEN 'agent1' END,
       (ARRAY['assistant','summary','translate','task_ai','doc_ai'])[1 + g % 5], 'gpt-4o-mini', 500 + (g % 900), 200 + (g % 400),
       now() - (random() * 180) * interval '1 day', 'openai', 'd' || (1 + g % 6), CASE WHEN g % 3 = 0 THEN 'task' END, CASE WHEN g % 3 = 0 THEN 't' || (g % 100000) END
FROM generate_series(1, 1000000) g;

-- 50k shared prompts (tsv is a generated column).
INSERT INTO ai.ai_prompt_library (id, author_id, title, body, topic, uses, created_at)
SELECT 'p' || g, 'u' || (1 + g % 60), 'Prompt ' || g || ' ' || (ARRAY['invoice','report','email','sql','test plan','release notes'])[1 + g % 6],
       'Write a ' || (ARRAY['invoice','report','email','sql','test plan','release notes'])[1 + g % 6] || ' for ' || md5(g::text), (ARRAY['code','writing','data','other'])[1 + g % 4],
       g % 37, now() - (g % 400) * interval '1 day'
FROM generate_series(1, 50000) g;

SET search_path = work, public;
INSERT INTO work.projects (id, code, name, owner_id) SELECT 'p' || g, 'P' || g, 'Project ' || g, 'u1' FROM generate_series(1, 50) g ON CONFLICT DO NOTHING;
INSERT INTO work.board_columns (project_id, id, name, status, position)
  SELECT 'p' || p, 'col' || c || '_p' || p, 'Col ' || c, (ARRAY['todo','in_progress','review','done'])[c], c FROM generate_series(1, 50) p, generate_series(1, 4) c ON CONFLICT DO NOTHING;
-- 600k tasks, 60 assignees, 50 projects, realistic status mix.
INSERT INTO work.tasks (id, code, title, description, owner_id, assignee_id, project_id, status, priority, due_at, rank, completed_at, created_at, updated_at, progress, column_id)
SELECT 't' || g, 'T-' || g, 'Task ' || g || ' ' || (ARRAY['fix login bug','write release notes','customer portal','invoice export','onboarding flow','quarterly report'])[1 + g % 6],
       '', 'u' || (1 + g % 60), 'u' || (1 + (g * 7) % 60), 'p' || (1 + g % 50),
       CASE WHEN g % 10 < 7 THEN 'done' WHEN g % 10 = 7 THEN 'todo' WHEN g % 10 = 8 THEN 'in_progress' ELSE 'review' END,
       (ARRAY['low','medium','high'])[1 + g % 3],
       now() - (random() * 300 - 30) * interval '1 day',
       lpad(to_hex(g), 8, '0'),
       CASE WHEN g % 10 < 7 THEN now() - (random() * 300) * interval '1 day' END,
       now() - (random() * 365) * interval '1 day', now() - (random() * 100) * interval '1 day', (g % 100)::smallint, 'col' || (CASE WHEN g % 10 < 7 THEN 4 WHEN g % 10 = 7 THEN 1 WHEN g % 10 = 8 THEN 2 ELSE 3 END) || '_p' || (1 + g % 50)
FROM generate_series(1, 600000) g;

SET search_path = chat, public;
INSERT INTO chat.channels (id, kind, created_by, name) SELECT 'ch' || g, 'public', 'u1', 'channel-' || g FROM generate_series(1, 100) g ON CONFLICT DO NOTHING;
-- 300k chat messages in 100 channels.
INSERT INTO chat.messages (id, channel_id, seq, author_id, author_type, body, mentions, created_at)
SELECT 'x' || g, 'ch' || (1 + g % 100), (g - 1) / 100 + 1, 'u' || (1 + g % 60), 'user',
       'Message ' || g || ' about the ' || (ARRAY['release','customer','invoice','meeting'])[1 + g % 4],
       CASE WHEN g % 20 = 0 THEN ARRAY['u1'] ELSE '{}' END, now() - (300000 - g) * interval '20 seconds'
FROM generate_series(1, 300000) g;

SET search_path = search, public;
-- 150k search documents.
INSERT INTO search.search_documents (entity_type, entity_id, container_id, acl_users, title, body, url, created_at, updated_at)
SELECT 'task', 's' || g, 'p' || (1 + g % 50), '{}',
       'Task ' || g || ' ' || (ARRAY['fix login bug','write release notes','customer portal','invoice export','onboarding flow','quarterly report'])[1 + g % 6],
       'The customer asked for the ' || (ARRAY['invoice','report','email','portal','release'])[1 + g % 5] || ' by Friday; see ' || md5(g::text),
       '/app/work/tasks/s' || g, now() - (g % 400) * interval '1 day', now() - (g % 400) * interval '1 hour'
FROM generate_series(1, 150000) g;

VACUUM ANALYZE ai.ai_conversations; VACUUM ANALYZE ai.ai_messages; VACUUM ANALYZE ai.ai_usage; VACUUM ANALYZE ai.ai_prompt_library;
VACUUM ANALYZE work.tasks; VACUUM ANALYZE chat.messages; VACUUM ANALYZE search.search_documents;
SELECT pg_size_pretty(pg_database_size(current_database()));
