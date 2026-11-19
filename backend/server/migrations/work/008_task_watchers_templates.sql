-- Task basics: people who follow a task without owning or doing it, and reusable task templates.

-- Watchers hear about comments and completion like the owner and assignee do. Removed with the task.
CREATE TABLE IF NOT EXISTS task_watchers (
    task_id text NOT NULL,
    user_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT task_watchers_pkey PRIMARY KEY (task_id, user_id),
    CONSTRAINT task_watchers_task_id_fkey FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
-- "Tasks I watch" and the per-person cleanup when someone leaves.
CREATE INDEX IF NOT EXISTS task_watchers_user_idx ON task_watchers USING btree (user_id);

-- A template is a task's shape (title, description, priority, labels, subtasks) saved to start new tasks from.
-- project_id null: offered everywhere; set: offered in that project. `payload` is
-- { title, description, priority, labels, subtasks: [title] }.
CREATE TABLE IF NOT EXISTS task_templates (
    id text NOT NULL,
    name text NOT NULL,
    project_id text,
    created_by text NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT task_templates_pkey PRIMARY KEY (id),
    CONSTRAINT task_templates_name_check CHECK (((length(name) >= 1) AND (length(name) <= 120))),
    CONSTRAINT task_templates_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS task_templates_project_idx ON task_templates USING btree (project_id);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE task_watchers TO workspace_work_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE task_templates TO workspace_work_rw;
