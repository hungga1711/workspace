-- Demo data that stays "today". The demo seed writes its moments relative to the day it ran; a week
-- later every task is late, the weekly AI report is empty and nobody has checked in. demo_clock remembers the moment
-- the data was true for (the seed sets it), and demo_refresh() moves the seeded data forward by the whole days
-- since then, so the demo looks like the seed just ran. The public demo calls it after each hourly restore
-- (infra/demo/reset.sh), Admin › Settings offers it on a demo workspace, and `pnpm demo:refresh` runs it locally.
--
-- What moves: every date and timestamp column of the modules' own tables, on rows that belong to the demo (made at
-- or before the anchor; real activity after it is left alone). Calendar items and leave move by whole weeks so a
-- Tuesday meeting stays a Tuesday. Attendance is drawn again for the last four weeks instead of moved (weekends,
-- leave, joiners, today's open check-ins). Never moved: credentials and sessions, migrations and event plumbing,
-- holidays, hire dates, prices, real computers' token logs (ai_local_*), search's index.

CREATE TABLE IF NOT EXISTS demo_clock (
    singleton boolean DEFAULT true NOT NULL,
    -- The moment the demo data is true for.
    anchor timestamp with time zone NOT NULL,
    refreshed_at timestamp with time zone,
    CONSTRAINT demo_clock_pkey PRIMARY KEY (singleton),
    CONSTRAINT demo_clock_one CHECK (singleton)
);

-- Which tables and columns move; pure, so the rule can be read and tested on its own.
CREATE OR REPLACE FUNCTION demo_shift_plan()
RETURNS TABLE (schema_name text, table_name text, cols text[], date_cols text[], row_col text, weekly boolean)
LANGUAGE sql STABLE SET search_path = pg_catalog
AS $$
  WITH c AS (
    SELECT c.table_schema::text AS s, c.table_name::text AS t, c.column_name::text AS col, c.data_type::text AS ty
      FROM information_schema.columns c
      JOIN information_schema.tables tb ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name AND tb.table_type = 'BASE TABLE'
     WHERE c.table_schema IN ('work', 'chat', 'employee', 'ai', 'home', 'platform', 'identity')
       AND c.data_type IN ('timestamp with time zone', 'timestamp without time zone', 'date')
       AND c.column_name NOT IN ('expires_at', 'retires_at', 'applied_at', 'processed_at', 'hire_date', 'effective_from', 'last_sent_week', 'month')
       AND c.table_name NOT IN ('schema_migrations', 'outbox', 'processed_events', 'dead_events', 'push_outbox', 'push_recent',
                                'demo_clock', 'client_errors', 'workspace', 'workspace_config', 'workspace_logo', 'webhooks', 'webhook_deliveries',
                                'holidays', 'employees', 'compensation', 'attendance', 'master_data_versions',
                                'ai_local_devices', 'ai_local_sessions', 'ai_local_usage', 'ai_model_prices', 'ai_connections', 'ai_spend_month',
                                'ai_report_settings', 'ai_hourly_stats', 'brief_cache', 'user_prefs', 'collab_drafts', 'whiteboard_drafts', 'link_previews')
       AND c.table_name NOT LIKE 'mcp\_%' AND c.table_name NOT LIKE 'auth\_%' AND c.table_name NOT LIKE 'oauth\_%' AND c.table_name NOT LIKE 'sso\_%'
       AND NOT (c.table_schema = 'identity' AND c.table_name NOT IN ('members', 'audit_log', 'auth_events'))
  )
  SELECT s, t,
         array_agg(col ORDER BY col) FILTER (WHERE ty <> 'date'),
         array_agg(col ORDER BY col) FILTER (WHERE ty = 'date'),
         -- The row's own moment: made at or before the anchor means it is demo data.
         (SELECT x FROM unnest(ARRAY['created_at', 'at', 'hour', 'started_at', 'first_at', 'asked_at', 'joined_at', 'saved_at', 'pinned_at',
                                     'voted_at', 'read_at', 'viewed_at', 'seen_at', 'first_joined_at', 'updated_at', 'last_at']) WITH ORDINALITY u(x, i)
           WHERE x = ANY (array_agg(col)) ORDER BY i LIMIT 1),
         (s, t) IN (('work', 'calendar_events'), ('employee', 'leave_requests'), ('work', 'meeting_recordings'), ('work', 'meeting_participants'))
    FROM c GROUP BY s, t;
$$;

CREATE OR REPLACE FUNCTION demo_refresh(p_now timestamp with time zone DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  a timestamp with time zone;
  days int;
  weeks int;
  p record;
  d int;
  sets text;
  n bigint;
  moved bigint := 0;
  tables int := 0;
  skipped text[] := '{}';
  att int := 0;
  tz text;
BEGIN
  SELECT anchor INTO a FROM platform.demo_clock FOR UPDATE;
  IF a IS NULL THEN
    RETURN jsonb_build_object('shifted', false, 'reason', 'no_anchor');
  END IF;
  days := floor(extract(epoch FROM (p_now - a)) / 86400)::int;
  IF days < 1 THEN
    RETURN jsonb_build_object('shifted', false, 'reason', 'fresh', 'anchor', a);
  END IF;
  weeks := round(days / 7.0)::int * 7;

  FOR p IN SELECT * FROM platform.demo_shift_plan() LOOP
    d := CASE WHEN p.weekly THEN weeks ELSE days END;
    CONTINUE WHEN d = 0;
    SELECT concat_ws(', ',
             (SELECT string_agg(format('%1$I = %1$I + make_interval(days => %2$s)', x, d), ', ') FROM unnest(coalesce(p.cols, '{}')) x),
             (SELECT string_agg(format('%1$I = %1$I + %2$s', x, d), ', ') FROM unnest(coalesce(p.date_cols, '{}')) x))
      INTO sets;
    BEGIN
      -- No unique key covers a moved column (those tables are left out above), so one pass is safe.
      IF p.row_col IS NULL THEN
        EXECUTE format('UPDATE %I.%I SET %s', p.schema_name, p.table_name, sets);
      ELSE
        EXECUTE format('UPDATE %I.%I SET %s WHERE %I <= $1', p.schema_name, p.table_name, sets, p.row_col) USING a;
      END IF;
      GET DIAGNOSTICS n = ROW_COUNT;
      moved := moved + n;
      IF n > 0 THEN tables := tables + 1; END IF;
    EXCEPTION WHEN unique_violation OR check_violation OR exclusion_violation OR datetime_field_overflow THEN
      skipped := skipped || format('%s.%s', p.schema_name, p.table_name);
    END;
  END LOOP;

  -- The hourly AI rollup merges into hours real use has filled since.
  CREATE TEMP TABLE demo_hours ON COMMIT DROP AS SELECT * FROM ai.ai_hourly_stats WHERE hour <= a;
  DELETE FROM ai.ai_hourly_stats WHERE hour <= a;
  INSERT INTO ai.ai_hourly_stats (hour, user_id, source, feature, provider, model, prompts, calls, input_tokens, output_tokens)
  SELECT hour + make_interval(days => days), user_id, source, feature, provider, model, prompts, calls, input_tokens, output_tokens FROM demo_hours
  ON CONFLICT (hour, user_id, source, feature, provider, model) DO UPDATE
    SET prompts = ai_hourly_stats.prompts + EXCLUDED.prompts, calls = ai_hourly_stats.calls + EXCLUDED.calls,
        input_tokens = ai_hourly_stats.input_tokens + EXCLUDED.input_tokens, output_tokens = ai_hourly_stats.output_tokens + EXCLUDED.output_tokens;
  GET DIAGNOSTICS n = ROW_COUNT;
  moved := moved + n;

  -- Attendance, drawn again: the people the seed gave check-ins to, the last four weeks of weekdays in the
  -- workspace's zone, nobody on approved leave or before joining, a few habitually late, today still open.
  SELECT timezone INTO tz FROM employee.workspace_settings LIMIT 1;
  tz := coalesce(nullif(tz, ''), 'UTC');
  CREATE TEMP TABLE demo_people ON COMMIT DROP AS
    SELECT user_id, count(*) FILTER (WHERE late_minutes > 0) >= 3 AS often_late FROM employee.attendance WHERE id LIKE 'seed%' GROUP BY user_id;
  DELETE FROM employee.attendance WHERE id LIKE 'seed%';
  INSERT INTO employee.attendance (id, user_id, day, check_in, check_out, source, late_minutes)
  SELECT 'seed' || lpad(row_number() OVER ()::text, 22, '0'), y.user_id, y.day, y.check_in,
         CASE WHEN y.day < (p_now AT TIME ZONE tz)::date THEN y.check_out END,
         CASE WHEN y.h % 5 = 0 THEN 'mobile' ELSE 'web' END, greatest(0, y.in_min - (9 * 60 + 10))
    FROM (
      SELECT x.*, (x.day::timestamp + x.in_min * interval '1 minute') AT TIME ZONE tz AS check_in,
             (x.day::timestamp + x.out_min * interval '1 minute') AT TIME ZONE tz AS check_out
        FROM (
          SELECT pp.user_id, g.day::date AS day, h.h,
                 (CASE WHEN pp.often_late AND h.h % 100 < 45 THEN 9 * 60 + 12 + h.h % 40 ELSE 8 * 60 + 25 + h.h % 44 END)::int AS in_min,
                 (17 * 60 + 15 + (h.h / 7) % 90)::int AS out_min
            FROM demo_people pp
            CROSS JOIN generate_series((p_now AT TIME ZONE tz)::date - 27, (p_now AT TIME ZONE tz)::date, interval '1 day') g(day)
            CROSS JOIN LATERAL (SELECT (hashtext(pp.user_id || g.day::date::text)::bigint & 2147483647) AS h) h
            LEFT JOIN employee.employees e ON e.user_id = pp.user_id
           WHERE extract(isodow FROM g.day) < 6
             AND h.h % 100 >= 3 -- the odd missed day
             AND (e.hire_date IS NULL OR e.hire_date <= g.day::date)
             AND NOT EXISTS (SELECT 1 FROM employee.leave_requests l WHERE l.user_id = pp.user_id AND l.status = 'approved' AND g.day::date BETWEEN l.start_date AND l.end_date)
             AND NOT EXISTS (SELECT 1 FROM employee.attendance r WHERE r.user_id = pp.user_id AND r.day = g.day::date)
        ) x
    ) y
   WHERE y.check_in <= p_now
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS att = ROW_COUNT;

  -- Yesterday's cached morning briefs describe the old days.
  DELETE FROM home.brief_cache;
  -- The AI pages leave out real computers' token logs while the workspace runs on demo data.
  UPDATE ai.workspace_settings SET demo_data = true;

  UPDATE platform.demo_clock SET anchor = anchor + make_interval(days => days), refreshed_at = p_now;
  RETURN jsonb_build_object('shifted', true, 'days', days, 'weeks', weeks, 'rows', moved, 'tables', tables, 'attendance', att, 'skipped', to_jsonb(skipped),
                            'anchor', a + make_interval(days => days));
END;
$$;

REVOKE ALL ON FUNCTION demo_refresh(timestamp with time zone) FROM PUBLIC;
REVOKE ALL ON FUNCTION demo_shift_plan() FROM PUBLIC;
GRANT SELECT ON TABLE demo_clock TO workspace_platform_rw;
GRANT EXECUTE ON FUNCTION demo_refresh(timestamp with time zone) TO workspace_platform_rw;
GRANT EXECUTE ON FUNCTION demo_shift_plan() TO workspace_platform_rw;
