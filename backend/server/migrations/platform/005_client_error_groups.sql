-- Browser errors: an admin marks a kind of error as handled. A group counts as resolved while no new
-- occurrence came after resolved_at; a later one reopens it (shown as "came back"). Rows are kept as long as errors are.
CREATE TABLE IF NOT EXISTS client_error_groups (
    group_key text PRIMARY KEY,
    resolved_at timestamp with time zone,
    resolved_by text
);
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE client_error_groups TO workspace_platform_rw;
