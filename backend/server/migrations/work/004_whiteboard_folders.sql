-- Whiteboard folders and access: boards sit in nested folders, and who may view, edit or manage a folder
-- or a board is a list of grants to everyone, a department or a person. A board (or folder) inherits its folder's
-- grants unless `inherit` is off, and adds its own. Creators always manage what they made; a folder's creator manages
-- what inherits from it. A board with no grant at all is private to its owner. docs/database/work.md, whiteboards.ts.

CREATE TABLE whiteboard_folders (
    id text NOT NULL,
    name text NOT NULL,
    parent_id text,
    owner_id text NOT NULL,
    inherit boolean DEFAULT true NOT NULL,
    "position" double precision DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT whiteboard_folders_pkey PRIMARY KEY (id),
    CONSTRAINT whiteboard_folders_name_check CHECK (((length(name) >= 1) AND (length(name) <= 120))),
    CONSTRAINT whiteboard_folders_parent_check CHECK ((parent_id IS DISTINCT FROM id)),
    CONSTRAINT whiteboard_folders_parent_fkey FOREIGN KEY (parent_id) REFERENCES whiteboard_folders(id)
);
CREATE INDEX whiteboard_folders_parent_idx ON whiteboard_folders USING btree (parent_id);

-- `subject_id` is '' for everyone, a department id or a user id.
CREATE TABLE whiteboard_grants (
    target_type text NOT NULL,
    target_id text NOT NULL,
    subject_type text NOT NULL,
    subject_id text DEFAULT ''::text NOT NULL,
    role text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT whiteboard_grants_pkey PRIMARY KEY (target_type, target_id, subject_type, subject_id),
    CONSTRAINT whiteboard_grants_target_check CHECK ((target_type = ANY (ARRAY['folder'::text, 'board'::text]))),
    CONSTRAINT whiteboard_grants_subject_check CHECK ((subject_type = ANY (ARRAY['everyone'::text, 'department'::text, 'user'::text]))),
    CONSTRAINT whiteboard_grants_everyone_check CHECK (((subject_type = 'everyone'::text) = (subject_id = ''::text))),
    CONSTRAINT whiteboard_grants_role_check CHECK ((role = ANY (ARRAY['view'::text, 'edit'::text, 'manage'::text])))
);

ALTER TABLE whiteboards ADD COLUMN folder_id text REFERENCES whiteboard_folders(id);
ALTER TABLE whiteboards ADD COLUMN inherit boolean DEFAULT true NOT NULL;
CREATE INDEX whiteboards_folder_idx ON whiteboards USING btree (folder_id) WHERE (folder_id IS NOT NULL);

-- Existing boards stay at the top level with the access they had: a company board stays editable by everyone, a
-- project board readable by everyone (its project's people still edit it, whiteboards.ts), a private board its
-- owner's only (no grant, and it does not inherit).
INSERT INTO whiteboard_grants (target_type, target_id, subject_type, subject_id, role)
SELECT 'board', id, 'everyone', '', CASE WHEN visibility = 'workspace' THEN 'edit' ELSE 'view' END
  FROM whiteboards WHERE visibility IN ('workspace', 'project');
UPDATE whiteboards SET inherit = false WHERE visibility = 'private';

ALTER TABLE whiteboards DROP CONSTRAINT whiteboards_project_check;
ALTER TABLE whiteboards DROP CONSTRAINT whiteboards_visibility_check;
ALTER TABLE whiteboards DROP COLUMN visibility;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE whiteboard_folders TO workspace_work_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE whiteboard_grants TO workspace_work_rw;
