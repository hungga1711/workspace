-- Demo data next to real computers. demo_data is set by platform.demo_refresh() (and the demo seed):
-- while it is on, the token pages leave out ai_local_* rows from computers that are not part of the demo (demo =
-- false), so one developer's real coding-agent logs do not swamp a 100-person demo company's numbers.
ALTER TABLE workspace_settings ADD COLUMN IF NOT EXISTS demo_data boolean DEFAULT false NOT NULL;
ALTER TABLE ai_local_devices ADD COLUMN IF NOT EXISTS demo boolean DEFAULT false NOT NULL;
