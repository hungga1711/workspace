-- Acting on a waiting agent run from its notification. `quick_actions`: the person lets pushes about a
-- run that waits for them carry buttons ("Approve", an either/or question's options) and say which task it is. Off by
-- default: a notification's buttons can be pressed on a locked phone. `push_outbox.ref`: what a queued push is about
-- ({ runId, waitId | questionId }), so the push job can ask the work module for those buttons as it sends.
ALTER TABLE user_prefs ADD COLUMN IF NOT EXISTS quick_actions boolean DEFAULT false NOT NULL;
ALTER TABLE push_outbox ADD COLUMN IF NOT EXISTS ref jsonb;

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
  )
  SELECT g.id, g.user_id, g.title, g.url, u.push_enabled, g.ref, u.quick_actions FROM gone g
    JOIN user_prefs u ON u.user_id = g.user_id
   WHERE u.push_enabled
     AND g.created_at > now() - interval '30 minutes'
     AND NOT (u.quiet_start IS NOT NULL AND u.quiet_end IS NOT NULL AND u.quiet_start <> u.quiet_end AND (
       CASE WHEN u.quiet_start < u.quiet_end
            THEN extract(hour FROM now() AT TIME ZONE u.timezone) >= u.quiet_start AND extract(hour FROM now() AT TIME ZONE u.timezone) < u.quiet_end
            ELSE extract(hour FROM now() AT TIME ZONE u.timezone) >= u.quiet_start OR extract(hour FROM now() AT TIME ZONE u.timezone) < u.quiet_end
       END))
$$;
REVOKE ALL ON FUNCTION claim_instant_pushes(lim integer) FROM PUBLIC;
GRANT ALL ON FUNCTION claim_instant_pushes(lim integer) TO workspace_home_rw;
