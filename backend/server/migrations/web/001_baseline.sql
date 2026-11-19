-- web schema: the web app's server-side sessions (frontend/web/src/lib/session.ts), reached by workspace_web.
--
-- A session must survive a restart, so it is a row here (ADR 0021).
-- The browser holds an opaque id; the key is a hash of it (with SESSION_SECRET), so a dump yields no usable cookie.
-- Only the web app's role can reach this schema at all.

DO $$
BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO workspace_web_rw', current_schema());
END
$$;

CREATE TABLE IF NOT EXISTS sessions (
  key        text PRIMARY KEY,
  data       jsonb NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions USING btree (expires_at);

-- One token refresh per session at a time (refresh tokens are single use, and a page renders many calls at once):
-- whoever inserts the row refreshes; a lock older than its deadline is taken over.
CREATE TABLE IF NOT EXISTS refresh_locks (
  key   text PRIMARY KEY,
  until timestamptz NOT NULL
);

GRANT SELECT, INSERT, UPDATE, DELETE ON sessions, refresh_locks TO workspace_web_rw;
