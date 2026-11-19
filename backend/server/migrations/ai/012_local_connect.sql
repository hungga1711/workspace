-- The AI on people's own computers: one program there (workspace-connect.mjs) says which AI it found
-- (command-line agents, local model servers) and what it does with it: workflows, answers, token counts, the safety
-- net. A computer's row is the one the token collector already keeps.
ALTER TABLE ai_local_devices ADD COLUMN IF NOT EXISTS last_seen_at timestamp with time zone;
ALTER TABLE ai_local_devices ADD COLUMN IF NOT EXISTS os text DEFAULT ''::text NOT NULL;
ALTER TABLE ai_local_devices ADD COLUMN IF NOT EXISTS version text DEFAULT ''::text NOT NULL;
-- What was found there: [{ id, name, kind: "agent" | "server", models?, cloud }].
ALTER TABLE ai_local_devices ADD COLUMN IF NOT EXISTS found jsonb DEFAULT '[]'::jsonb NOT NULL;
-- What the program is doing: { workflow, usage, guard, dir }.
ALTER TABLE ai_local_devices ADD COLUMN IF NOT EXISTS state jsonb DEFAULT '{}'::jsonb NOT NULL;
-- The AI its owner picked for workflows there ("<id>" or "<id>:<model>"; empty: the first one found).
ALTER TABLE ai_local_devices ADD COLUMN IF NOT EXISTS prefer text DEFAULT ''::text NOT NULL;
-- The public prefix of the personal key it signs in with, so "disconnect" can revoke exactly that key.
ALTER TABLE ai_local_devices ADD COLUMN IF NOT EXISTS key_prefix text DEFAULT ''::text NOT NULL;

-- A fourth way to connect the company's AI: the AI on an admin's own connected computer ("device"). base_url is
-- device://<user id>/<device>/<ai id>; questions are handed to that computer and it answers.
ALTER TABLE ai_connections DROP CONSTRAINT IF EXISTS ai_connections_mode_check;
ALTER TABLE ai_connections ADD CONSTRAINT ai_connections_mode_check CHECK (mode = ANY (ARRAY['key', 'api', 'selfhost', 'device']));
ALTER TABLE ai_connections DROP CONSTRAINT IF EXISTS ai_connections_vendor_check;
ALTER TABLE ai_connections ADD CONSTRAINT ai_connections_vendor_check CHECK (vendor = ANY (ARRAY['openai', 'anthropic', 'gemini', 'openai_compatible', 'device']));
