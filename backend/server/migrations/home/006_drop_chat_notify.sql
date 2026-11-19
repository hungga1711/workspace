-- Telegram and Zalo notifications removed: web push, email and the inbox are the channels. Instant
-- pushes now go only to people who keep web push on.
CREATE OR REPLACE FUNCTION claim_instant_pushes(lim integer)
    RETURNS TABLE(id text, user_id text, title text, url text, push_enabled boolean)
    LANGUAGE sql
    SET search_path FROM CURRENT
    AS $$
  WITH picked AS (
    SELECT o.id FROM push_outbox o ORDER BY o.created_at LIMIT lim FOR UPDATE SKIP LOCKED
  ), gone AS (
    DELETE FROM push_outbox o USING picked p WHERE o.id = p.id
    RETURNING o.id, o.user_id, o.title, o.url, o.created_at
  )
  SELECT g.id, g.user_id, g.title, g.url, u.push_enabled FROM gone g
    JOIN user_prefs u ON u.user_id = g.user_id
   WHERE u.push_enabled
     AND g.created_at > now() - interval '30 minutes'
     AND NOT (u.quiet_start IS NOT NULL AND u.quiet_end IS NOT NULL AND u.quiet_start <> u.quiet_end AND (
       CASE WHEN u.quiet_start < u.quiet_end
            THEN extract(hour FROM now() AT TIME ZONE u.timezone) >= u.quiet_start AND extract(hour FROM now() AT TIME ZONE u.timezone) < u.quiet_end
            ELSE extract(hour FROM now() AT TIME ZONE u.timezone) >= u.quiet_start OR extract(hour FROM now() AT TIME ZONE u.timezone) < u.quiet_end
       END))
$$;

DROP TABLE notify_link_codes;
DROP TABLE notify_links;
DROP TABLE notify_channels;
