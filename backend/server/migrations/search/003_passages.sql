-- Passages for AI retrieval (ADR 0013 addendum).
--
-- search_documents answers "find the page"; the AI needs "find the paragraph": a question about one clause of a long
-- contract must bring back that clause, not the first lines of the file. Long text is cut into overlapping passages
-- of about a thousand characters (service-kit search.ts splitPassages), each with its nearest heading, its own
-- tsvector and its parent's container and ACL, so the same permission filter applies.
--
-- Passages hold what search_documents does not: a task with its comments, the whole of a page, a meeting's agenda and
-- minutes, calendar entries, the text of files (PDF, Word, Excel, PowerPoint) and requests. Messages, projects and
-- whiteboards are short and stay in search_documents only; searchPassages reads both.

ALTER TABLE search_documents DROP CONSTRAINT IF EXISTS search_documents_entity_type_check;
ALTER TABLE search_documents ADD CONSTRAINT search_documents_entity_type_check CHECK ((entity_type = ANY (ARRAY[
    'message'::text, 'thread'::text, 'channel'::text, 'task'::text, 'project'::text, 'document'::text, 'file'::text,
    'person'::text, 'whiteboard'::text, 'meeting'::text, 'event'::text, 'approval'::text])));

CREATE TABLE IF NOT EXISTS search_passages (
    entity_type text NOT NULL,
    entity_id text NOT NULL,
    seq integer NOT NULL,
    container_id text NOT NULL,
    acl_users text[] DEFAULT '{}'::text[] NOT NULL,
    title text DEFAULT ''::text NOT NULL,
    -- The nearest heading above the passage ("Refunds › After 30 days"): context for the reader and for ranking.
    heading text DEFAULT ''::text NOT NULL,
    body text NOT NULL,
    url text NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    tsv tsvector GENERATED ALWAYS AS ((setweight(to_tsvector('workspace_search'::regconfig, title), 'A'::"char") || setweight(to_tsvector('workspace_search'::regconfig, heading), 'B'::"char") || setweight(to_tsvector('workspace_search'::regconfig, body), 'C'::"char"))) STORED,
    CONSTRAINT search_passages_pkey PRIMARY KEY (entity_type, entity_id, seq),
    CONSTRAINT search_passages_entity_type_check CHECK ((entity_type = ANY (ARRAY['task'::text, 'document'::text, 'meeting'::text, 'event'::text, 'file'::text, 'approval'::text])))
);
CREATE INDEX IF NOT EXISTS search_passages_tsv_idx ON search_passages USING gin (tsv);
CREATE INDEX IF NOT EXISTS search_passages_acl_idx ON search_passages USING gin (acl_users);
CREATE INDEX IF NOT EXISTS search_passages_container_idx ON search_passages USING btree (container_id);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE search_passages TO workspace_search_rw;
GRANT SELECT ON TABLE search_passages TO workspace_maintenance;
GRANT SELECT ON TABLE search_passages TO workspace_search_reader;
