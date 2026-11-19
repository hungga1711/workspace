-- The words of files, for search and AI retrieval (src/modules/work/knowledge.ts). A background job reads
-- Drive files and the attachments of tasks and pages (text, PDF, Word, Excel, PowerPoint) a few at a time and keeps
-- what it found here; the search index cuts it into passages. One row per file: 'done' with its text, 'none' for a
-- file with no words to read (an image, a video), 'failed' while a read is still being retried.
CREATE TABLE IF NOT EXISTS file_texts (
    file_id text NOT NULL,
    status text NOT NULL,
    text text,
    chars integer DEFAULT 0 NOT NULL,
    attempts integer DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT file_texts_pkey PRIMARY KEY (file_id),
    CONSTRAINT file_texts_file_id_fkey FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE,
    CONSTRAINT file_texts_status_check CHECK ((status = ANY (ARRAY['done'::text, 'none'::text, 'failed'::text])))
);
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE file_texts TO workspace_work_rw;
