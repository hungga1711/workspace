-- The integrations hub (src/modules/work/integrations/): outside tools shown where the work is. An
-- integration is code in this repository (one provider file); these tables hold what a company does with one.

-- The company's connection to one integration: whose token (encrypted, never returned), and for GitHub and GitLab
-- the repositories looked through for pull and merge requests that name a task code. `web_base` is the site people
-- open, `api_base` its API: the provider's own, or the company's self-hosted address. `private_network`: the admin
-- said that address is inside the company's network, so requests to it (and only to it) skip the public-address rule.
CREATE TABLE IF NOT EXISTS integration_connections (
    id text NOT NULL,
    provider text NOT NULL,
    web_base text NOT NULL,
    api_base text NOT NULL,
    private_network boolean DEFAULT false NOT NULL,
    account text DEFAULT ''::text NOT NULL,
    secret_enc text NOT NULL,
    repos text[] DEFAULT '{}'::text[] NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    scan_cursor_at timestamp with time zone,
    last_ok_at timestamp with time zone,
    last_error text,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT integration_connections_pkey PRIMARY KEY (id),
    CONSTRAINT integration_connections_site_key UNIQUE (provider, web_base)
);
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE integration_connections TO workspace_work_rw;

-- A task's linked work: a pull or merge request, an issue, a design. `source`: 'manual' someone added it, 'found' its
-- address is in the task's description or comments, 'scan' it names the task's code in a watched repository. `card`
-- is what the provider last read (state, branches, checks, reviewers…), `thumbnail` a small preview as a data URL.
-- Removing a found or scanned link only hides it (`dismissed`), so it does not come back on the next look.
CREATE TABLE IF NOT EXISTS task_work_links (
    id text NOT NULL,
    task_id text NOT NULL,
    provider text NOT NULL,
    url text NOT NULL,
    ref_key text NOT NULL,
    ref jsonb DEFAULT '{}'::jsonb NOT NULL,
    kind text NOT NULL,
    source text DEFAULT 'manual'::text NOT NULL,
    dismissed boolean DEFAULT false NOT NULL,
    card jsonb,
    card_at timestamp with time zone,
    error text,
    thumbnail text,
    added_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT task_work_links_pkey PRIMARY KEY (id),
    CONSTRAINT task_work_links_task_id_fkey FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    CONSTRAINT task_work_links_ref_key UNIQUE (task_id, provider, ref_key),
    CONSTRAINT task_work_links_source_check CHECK ((source = ANY (ARRAY['manual'::text, 'found'::text, 'scan'::text])))
);
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE task_work_links TO workspace_work_rw;
