-- The AI report email becomes opt-out: a first report 7 days after the install, then every Monday.
-- `since` is when the ai module first ran with this migration (the install, for new workspaces); `first_sent_at`
-- marks the first report as sent. An existing row keeps the admin's own choice of weekly_email.
ALTER TABLE ai_report_settings ALTER COLUMN weekly_email SET DEFAULT true;
ALTER TABLE ai_report_settings ADD COLUMN IF NOT EXISTS since timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE ai_report_settings ADD COLUMN IF NOT EXISTS first_sent_at timestamp with time zone;
INSERT INTO ai_report_settings (weekly_email) VALUES (true) ON CONFLICT (singleton) DO NOTHING;
