import { readJson, statusFromName, type Connector, type ExternalTask } from "../types.js";

/**
 * ClickUp (personal API token, pk_…): each list becomes a project. Status type closed/done is done; custom statuses
 * are read by name. The key is the task's custom id when the space uses them (DEV-42), else none.
 */
const API = "https://api.clickup.com/api/v2";

interface CuTask {
  id: string;
  custom_id: string | null;
  name: string;
  url: string | null;
  status: { status: string; type: string };
  date_created: string | null;
  date_updated: string | null;
  date_closed: string | null;
  date_done: string | null;
  start_date: string | null;
  due_date: string | null;
  assignees: { email?: string | null }[];
  list?: { id: string };
}

const ms = (v: string | null | undefined) => (v && /^\d+$/.test(v) ? new Date(Number(v)).toISOString() : null);

export function clickupStatus(s: { status: string; type: string }): ExternalTask["status"] {
  if (s.type === "closed" || s.type === "done") return statusFromName(s.status, "done") === "cancelled" ? "cancelled" : "done";
  if (s.type === "open") return "todo";
  return statusFromName(s.status, "in_progress");
}

export const clickup: Connector = {
  provider: "clickup",
  async listProjects(cred, f) {
    const h = { Authorization: cred.token };
    const teams = await readJson<{ teams: { id: string; name: string }[] }>("clickup", await f(`${API}/team`, { headers: h }));
    const out = [];
    for (const team of teams.teams) {
      const spaces = await readJson<{ spaces: { id: string; name: string }[] }>("clickup", await f(`${API}/team/${team.id}/space?archived=false`, { headers: h }));
      for (const space of spaces.spaces) {
        const folders = await readJson<{ folders: { id: string; name: string; lists: { id: string; name: string }[] }[] }>(
          "clickup",
          await f(`${API}/space/${space.id}/folder?archived=false`, { headers: h }),
        );
        const loose = await readJson<{ lists: { id: string; name: string }[] }>("clickup", await f(`${API}/space/${space.id}/list?archived=false`, { headers: h }));
        for (const l of loose.lists) out.push({ id: l.id, name: `${space.name} › ${l.name}` });
        for (const fo of folders.folders) for (const l of fo.lists) out.push({ id: l.id, name: `${space.name} › ${fo.name} › ${l.name}` });
      }
    }
    return out;
  },
  async fetchTasks(cred, projectIds, since, f) {
    const h = { Authorization: cred.token };
    const out: ExternalTask[] = [];
    for (const list of projectIds) {
      for (let page = 0; page < 200; page++) {
        const q = new URLSearchParams({ include_closed: "true", subtasks: "true", page: String(page), order_by: "updated" });
        if (since) q.set("date_updated_gt", String(since.getTime()));
        const r = await readJson<{ tasks: CuTask[]; last_page?: boolean }>("clickup", await f(`${API}/list/${list}/task?${q}`, { headers: h }));
        for (const t of r.tasks) {
          const status = clickupStatus(t.status);
          out.push({
            id: t.id,
            // Custom ids (DEV-42) where the space uses them, else the task id as people paste it (#86B1X2Y3Z).
            key: t.custom_id ? t.custom_id.toUpperCase() : `#${t.id.toUpperCase()}`,
            title: t.name || "(untitled)",
            url: t.url,
            projectId: list,
            assigneeEmail: t.assignees[0]?.email ?? null,
            status,
            createdAt: ms(t.date_created),
            startedAt: ms(t.start_date),
            completedAt: status === "done" ? (ms(t.date_done) ?? ms(t.date_closed)) : null,
            dueAt: ms(t.due_date),
            updatedAt: ms(t.date_updated),
          });
        }
        if (r.last_page !== false || r.tasks.length < 100) break;
      }
    }
    return out;
  },
};
