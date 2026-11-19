-- The prompt library gets two levels. Company prompts are set up by people holding ai.prompt.manage and
-- shown to everyone or to chosen departments. Personal prompts are each person's own: private, shared with the
-- author's department, or with everyone. A personal prompt can be proposed to the company. That copy waits as
-- `proposed` until someone who may manage company prompts approves it (`live`) or declines it.
-- Rows shared before this were open to everyone, so they become personal prompts visible to everyone.
ALTER TABLE ai_prompt_library
    ADD COLUMN level text DEFAULT 'personal'::text NOT NULL,
    ADD COLUMN visibility text DEFAULT 'everyone'::text NOT NULL,
    ADD COLUMN department_id text,
    ADD COLUMN audience text[] DEFAULT '{}'::text[] NOT NULL,
    ADD COLUMN status text DEFAULT 'live'::text NOT NULL,
    ADD COLUMN source_id text,
    ADD COLUMN pinned boolean DEFAULT false NOT NULL,
    ADD COLUMN description text DEFAULT ''::text NOT NULL,
    ADD COLUMN updated_at timestamp with time zone DEFAULT now() NOT NULL,
    ADD COLUMN updated_by text,
    ADD COLUMN reviewed_by text,
    ADD COLUMN review_note text,
    ADD CONSTRAINT ai_prompt_library_level_check CHECK ((level = ANY (ARRAY['company'::text, 'personal'::text]))),
    ADD CONSTRAINT ai_prompt_library_visibility_check CHECK ((visibility = ANY (ARRAY['private'::text, 'department'::text, 'everyone'::text]))),
    ADD CONSTRAINT ai_prompt_library_status_check CHECK ((status = ANY (ARRAY['live'::text, 'proposed'::text, 'declined'::text]))),
    ADD CONSTRAINT ai_prompt_library_description_check CHECK ((length(description) <= 300));

UPDATE ai_prompt_library SET updated_at = created_at;

-- "Của tôi" lists by author; the company list and the review queue by level and status.
CREATE INDEX ai_prompt_library_author_idx ON ai_prompt_library USING btree (author_id, updated_at DESC);
CREATE INDEX ai_prompt_library_level_idx ON ai_prompt_library USING btree (level, status);
CREATE INDEX ai_prompt_library_source_idx ON ai_prompt_library USING btree (source_id) WHERE (source_id IS NOT NULL);
