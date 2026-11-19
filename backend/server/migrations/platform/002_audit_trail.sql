-- The audit trail (ADR 0025, docs/architecture/audit-log.md): one append-only record of who did what
-- across every module. The `platform-audit` consumer writes it from domain events and `audit.entry.recorded.v1`;
-- platform's own admin actions insert directly. Private content (messages, page and board text, comments, prompts,
-- descriptions, secrets) never lands here: the consumer's privacy filter strips it.

SET LOCAL check_function_bodies = false;

CREATE TABLE IF NOT EXISTS audit_trail (
    -- The event id it came from (redelivery is a no-op), or a new ULID for a direct insert.
    id text NOT NULL,
    at timestamp with time zone NOT NULL,
    -- user | agent | apikey | system | anonymous; actor_id is the user, agent or key id ('' for system/anonymous).
    actor_type text NOT NULL,
    actor_id text NOT NULL,
    -- How the actor called: session | personal_key | workspace_key | oauth (MCP); null for background work.
    via text,
    ip text,
    user_agent text,
    module text NOT NULL,
    -- module.entity.verb, e.g. work.task.status_changed
    action text NOT NULL,
    target_type text NOT NULL,
    target_id text NOT NULL,
    -- A readable name at the time (task code and title, email, channel name); null when private.
    target_label text,
    outcome text DEFAULT 'success'::text NOT NULL,
    request_id text,
    -- Field → { from, to } for non-private scalar fields.
    changes jsonb DEFAULT '{}'::jsonb NOT NULL,
    meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT audit_trail_pkey PRIMARY KEY (id),
    CONSTRAINT audit_trail_outcome_check CHECK ((outcome = ANY (ARRAY['success'::text, 'failure'::text, 'denied'::text])))
);

CREATE INDEX IF NOT EXISTS audit_trail_at_idx ON audit_trail USING btree (at DESC, id DESC);
CREATE INDEX IF NOT EXISTS audit_trail_actor_idx ON audit_trail USING btree (actor_id, at DESC);
CREATE INDEX IF NOT EXISTS audit_trail_target_idx ON audit_trail USING btree (target_type, target_id, at DESC);
CREATE INDEX IF NOT EXISTS audit_trail_action_idx ON audit_trail USING btree (action, at DESC);
CREATE INDEX IF NOT EXISTS audit_trail_request_idx ON audit_trail USING btree (request_id) WHERE (request_id IS NOT NULL);

-- The last audited state of a task, project, page or board, so an `updated` event (which carries only the new state)
-- becomes "status todo → doing". Private fields are kept as a hash only, to say "description changed" without it.
CREATE TABLE IF NOT EXISTS audit_subjects (
    type text NOT NULL,
    id text NOT NULL,
    version integer,
    state jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT audit_subjects_pkey PRIMARY KEY (type, id)
);

-- Trail rows older than keep_days, oldest first, at most lim rows (the retention job). The module's role may not
-- delete from the trail: only this function, owned by the maintenance role, can.
CREATE OR REPLACE FUNCTION audit_trail_prune(keep_days integer, lim integer) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path FROM CURRENT
    AS $$
DECLARE n integer;
BEGIN
  DELETE FROM audit_trail a
   USING (SELECT id FROM audit_trail WHERE at < now() - make_interval(days => greatest(keep_days, 1)) ORDER BY at LIMIT lim) old
   WHERE a.id = old.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

-- Earlier workspace-settings entries carry over, so the trail starts with the history that exists.
INSERT INTO audit_trail (id, at, actor_type, actor_id, module, action, target_type, target_id, meta)
SELECT id, at,
       CASE WHEN actor LIKE 'user:%' THEN 'user' WHEN actor LIKE 'agent:%' THEN 'agent' ELSE 'system' END,
       CASE WHEN actor LIKE 'user:%' OR actor LIKE 'agent:%' THEN split_part(actor, ':', 2) ELSE '' END,
       'platform', 'platform.' || action, resource, resource_id, metadata
  FROM audit_log
ON CONFLICT (id) DO NOTHING;

-- Append-only for the module: no UPDATE or DELETE on the trail (the schema's default privileges would grant them).
REVOKE ALL ON TABLE audit_trail FROM workspace_platform_rw;
GRANT SELECT,INSERT ON TABLE audit_trail TO workspace_platform_rw;
GRANT SELECT,DELETE ON TABLE audit_trail TO workspace_maintenance;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE audit_subjects TO workspace_platform_rw;
REVOKE ALL ON FUNCTION audit_trail_prune(keep_days integer, lim integer) FROM PUBLIC;
GRANT ALL ON FUNCTION audit_trail_prune(keep_days integer, lim integer) TO workspace_platform_rw;
ALTER FUNCTION audit_trail_prune(keep_days integer, lim integer) OWNER TO workspace_maintenance;
