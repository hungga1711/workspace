-- Browser errors: what the web app's error screen reports. The screen shows the person a short code
-- (C-XXXXXXXX); the admin pastes it in Admin › Lỗi trình duyệt and sees the readable stack. Rows live 30 days
-- (CLIENT_ERRORS_RETENTION_DAYS); the module's own role deletes them (default privileges).

CREATE TABLE IF NOT EXISTS client_errors (
    id text NOT NULL,
    -- The reference the error screen shows; one per occurrence.
    code text NOT NULL,
    -- boundary (an error screen was shown) | uncaught (window.onerror, the page kept running).
    kind text NOT NULL,
    message text NOT NULL,
    -- Same error, same group: a hash of the message with ids, numbers and quoted text removed.
    group_key text NOT NULL,
    stack text,
    -- [{ file, line, col, name, raw }], source positions when the build's source maps were found.
    frames jsonb DEFAULT '[]'::jsonb NOT NULL,
    -- The route template (/app/work/tasks/[id]) and the real path.
    route text,
    path text,
    user_id text,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT client_errors_pkey PRIMARY KEY (id),
    CONSTRAINT client_errors_kind_check CHECK ((kind = ANY (ARRAY['boundary'::text, 'uncaught'::text])))
);

CREATE INDEX IF NOT EXISTS client_errors_code_idx ON client_errors USING btree (code);
CREATE INDEX IF NOT EXISTS client_errors_at_idx ON client_errors USING btree (created_at DESC);
CREATE INDEX IF NOT EXISTS client_errors_group_idx ON client_errors USING btree (group_key, created_at DESC);
