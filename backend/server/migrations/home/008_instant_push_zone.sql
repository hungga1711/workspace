-- Quiet hours are read in the person's zone, else the workspace's, like the digest and the due-reminder jobs. A person
-- with quiet hours and no zone of their own got NULL for the hour, so every claimed push was deleted without being sent.
DROP FUNCTION IF EXISTS claim_instant_pushes(integer);
CREATE FUNCTION claim_instant_pushes(lim integer)
    RETURNS TABLE(id text, user_id text, title text, url text, push_enabled boolean, ref jsonb, quick_actions boolean)
    LANGUAGE sql
    SET search_path FROM CURRENT
    AS $$
  WITH picked AS (
    SELECT o.id FROM push_outbox o ORDER BY o.created_at LIMIT lim FOR UPDATE SKIP LOCKED
  ), gone AS (
    DELETE FROM push_outbox o USING picked p WHERE o.id = p.id
    RETURNING o.id, o.user_id, o.title, o.url, o.created_at, o.ref
  ), people AS (
    SELECT p.*, extract(hour FROM now() AT TIME ZONE coalesce(p.timezone, (SELECT w.timezone FROM workspace_settings w), 'UTC')) AS hour
      FROM user_prefs p
  )
  SELECT g.id, g.user_id, g.title, g.url, u.push_enabled, g.ref, u.quick_actions FROM gone g
    JOIN people u ON u.user_id = g.user_id
   WHERE u.push_enabled
     AND g.created_at > now() - interval '30 minutes'
     AND NOT (u.quiet_start IS NOT NULL AND u.quiet_end IS NOT NULL AND u.quiet_start <> u.quiet_end AND (
       CASE WHEN u.quiet_start < u.quiet_end
            THEN u.hour >= u.quiet_start AND u.hour < u.quiet_end
            ELSE u.hour >= u.quiet_start OR u.hour < u.quiet_end
       END))
$$;
REVOKE ALL ON FUNCTION claim_instant_pushes(lim integer) FROM PUBLIC;
GRANT ALL ON FUNCTION claim_instant_pushes(lim integer) TO workspace_home_rw;
