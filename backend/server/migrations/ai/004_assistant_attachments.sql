-- Hỏi đáp: images and files attached to a question, and the work it points at with @ (task, document,
-- project, meeting).
--
-- A file is kept as the text the model read (PDF and text files; capped), an image as the downscaled picture the
-- browser sent, so a reopened conversation still shows it and a follow-up question still has the file. Only the person
-- who asked reads them (GET /assistant/files/:id); no oversight page lists them.
CREATE TABLE IF NOT EXISTS ai_message_files (
    id text NOT NULL,
    message_id text NOT NULL,
    user_id text NOT NULL,
    name text NOT NULL,
    content_type text NOT NULL,
    size integer NOT NULL,
    kind text NOT NULL,
    data bytea,
    text text DEFAULT ''::text NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_message_files_pkey PRIMARY KEY (id),
    CONSTRAINT ai_message_files_kind_check CHECK ((kind = ANY (ARRAY['image'::text, 'file'::text]))),
    CONSTRAINT ai_message_files_message_fk FOREIGN KEY (message_id) REFERENCES ai_messages(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ai_message_files_message_idx ON ai_message_files USING btree (message_id);

-- What the question pointed at with @: [{ kind, id, label }]. The content is read again (as the asker) when needed.
ALTER TABLE ai_messages ADD COLUMN IF NOT EXISTS refs jsonb;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ai_message_files TO workspace_ai_rw;
GRANT SELECT,DELETE ON TABLE ai_message_files TO workspace_maintenance;
