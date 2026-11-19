import { dueFrom, readJson, statusFromName, type Connector, type ExternalTask } from "../types.js";

/** Asana (personal access token): projects become projects; a task's board section names its status. No task keys. */
const API = "https://app.asana.com/api/1.0";
const TASK_FIELDS = "name,completed,completed_at,created_at,modified_at,due_on,due_at,assignee.email,permalink_url,memberships.project.gid,memberships.section.name";

interface Page<T> {
  data: T[];
  next_page?: { offset: string } | null;
}
interface AsanaTask {
  gid: string;
  name: string;
  completed: boolean;
  completed_at: string | null;
  created_at: string | null;
  modified_at: string | null;
  due_on: string | null;
  due_at: string | null;
  assignee: { email?: string | null } | null;
  permalink_url: string | null;
  memberships?: { project?: { gid: string }; section?: { name: string } | null }[];
}

export const asana: Connector = {
  provider: "asana",
  async listProjects(cred, f) {
    const h = { Authorization: `Bearer ${cred.token}`, Accept: "application/json" };
    const ws = await readJson<Page<{ gid: string; name: string }>>("asana", await f(`${API}/workspaces?limit=100`, { headers: h }));
    const out = [];
    for (const w of ws.data) {
      let offset: string | null = null;
      do {
        const q = new URLSearchParams({ workspace: w.gid, archived: "false", opt_fields: "name", limit: "100" });
        if (offset) q.set("offset", offset);
        const page: Page<{ gid: string; name: string }> = await readJson("asana", await f(`${API}/projects?${q}`, { headers: h }));
        out.push(...page.data.map((p) => ({ id: p.gid, name: ws.data.length > 1 ? `${p.name} · ${w.name}` : p.name })));
        offset = page.next_page?.offset ?? null;
      } while (offset);
    }
    return out;
  },
  async fetchTasks(cred, projectIds, since, f) {
    const h = { Authorization: `Bearer ${cred.token}`, Accept: "application/json" };
    const out: ExternalTask[] = [];
    for (const project of projectIds) {
      let offset: string | null = null;
      do {
        const q = new URLSearchParams({ project, opt_fields: TASK_FIELDS, limit: "100" });
        if (since) q.set("modified_since", since.toISOString());
        if (offset) q.set("offset", offset);
        const page: Page<AsanaTask> = await readJson("asana", await f(`${API}/tasks?${q}`, { headers: h }));
        for (const t of page.data) {
          const section = t.memberships?.find((m) => m.project?.gid === project)?.section?.name ?? null;
          // An open task in a "Done" section is still open: only Asana's completed flag finishes it.
          const named = statusFromName(section, "todo");
          out.push({
            id: t.gid,
            key: null,
            title: t.name || "(untitled)",
            url: t.permalink_url,
            projectId: project,
            assigneeEmail: t.assignee?.email ?? null,
            status: t.completed ? "done" : named === "done" ? "todo" : named,
            createdAt: t.created_at,
            startedAt: null,
            completedAt: t.completed ? t.completed_at : null,
            dueAt: dueFrom(t.due_on, t.due_at),
            updatedAt: t.modified_at,
          });
        }
        offset = page.next_page?.offset ?? null;
      } while (offset);
    }
    return out;
  },
};
