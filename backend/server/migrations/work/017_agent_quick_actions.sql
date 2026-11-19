-- Acting on a waiting run from a notification (src/modules/work/quick-actions.ts): "Approve", or one of a
-- single choice question's options, pressed on the notification itself. Each button carries a token made for one
-- person, one wait and one action; it works once, for an hour, and only together with that person's own session.
-- Only its SHA-256 is kept. `answer`: what the button answers ({ questionId: option }); null for an approval.
CREATE TABLE IF NOT EXISTS agent_quick_actions (
    token_hash text NOT NULL,
    user_id text NOT NULL,
    run_id text NOT NULL,
    wait_id text NOT NULL,
    action text NOT NULL,
    answer jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    CONSTRAINT agent_quick_actions_pkey PRIMARY KEY (token_hash),
    CONSTRAINT agent_quick_actions_run_id_fkey FOREIGN KEY (run_id) REFERENCES task_agent_runs(id) ON DELETE CASCADE,
    CONSTRAINT agent_quick_actions_action_check CHECK ((action = ANY (ARRAY['approve'::text, 'answer'::text])))
);
CREATE INDEX IF NOT EXISTS agent_quick_actions_wait_idx ON agent_quick_actions USING btree (user_id, wait_id);
CREATE INDEX IF NOT EXISTS agent_quick_actions_expires_idx ON agent_quick_actions USING btree (expires_at);
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE agent_quick_actions TO workspace_work_rw;
