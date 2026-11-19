-- Each person's own AI: the company's connection (ai_connections) stays everyone's default; a person may
-- pick an AI found on one of their own connected computers (ai_local_devices) for their own questions instead. Read
-- with a join on that computer's row, so a computer that is forgotten or removed takes the choice with it.
CREATE TABLE IF NOT EXISTS ai_personal_choice (
    user_id text NOT NULL,
    device text NOT NULL,
    ai text NOT NULL,
    -- A model server's model ("" for a command-line agent, which answers with its own).
    model text DEFAULT ''::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_personal_choice_pkey PRIMARY KEY (user_id)
);
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ai_personal_choice TO workspace_ai_rw;
GRANT SELECT,DELETE ON TABLE ai_personal_choice TO workspace_maintenance;

-- The company may keep everyone on its own connection (Admin › AI): off, people's choices are kept but not used.
ALTER TABLE ai_policy ADD COLUMN IF NOT EXISTS allow_personal_ai boolean DEFAULT true NOT NULL;
