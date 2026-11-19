import { dueFrom, readJson, statusFromName, SyncApiError, type Connector, type Credentials, type ExternalTask } from "../types.js";

/**
 * Jira Cloud (account email + API token, basic auth): projects become projects, issues keep their key (ENG-123).
 * Status category: new → todo, indeterminate → in progress (review by name), done → done (cancelled by name).
 */
interface Issue {
  id: string;
  key: string;
  fields: {
    summary: string;
    status: { name: string; statusCategory: { key: string } };
    assignee: { emailAddress?: string | null } | null;
    created: string | null;
    updated: string | null;
    resolutiondate: string | null;
    duedate: string | null;
    project: { id: string };
  };
}

export function jiraStatus(s: { name: string; statusCategory: { key: string } }): ExternalTask["status"] {
  if (s.statusCategory.key === "done") return statusFromName(s.name, "done") === "cancelled" ? "cancelled" : "done";
  if (s.statusCategory.key === "indeterminate") return statusFromName(s.name, "in_progress") === "review" ? "review" : "in_progress";
  return "todo";
}

/** https://acme.atlassian.net, whatever the admin pasted (a board URL, no scheme, a trailing slash). */
export function jiraSite(site: string | null | undefined): string {
  const raw = (site ?? "").trim();
  if (!raw) throw new SyncApiError("jira", 400, "Jira needs the site address, like https://your-company.atlassian.net");
  const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  if (u.protocol !== "https:") throw new SyncApiError("jira", 400, "the Jira site address must use https");
  return `https://${u.host}`;
}

function headers(cred: Credentials) {
  if (!cred.email) throw new SyncApiError("jira", 400, "Jira needs the email of the account the API token belongs to");
  return { Authorization: `Basic ${Buffer.from(`${cred.email}:${cred.token}`).toString("base64")}`, Accept: "application/json", "Content-Type": "application/json" };
}

/** JQL's date literal: "2026-11-09 08:30" (minutes; Jira compares in the account's zone, so a little overlap is re-read). */
const jqlDate = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ");

export const jira: Connector = {
  provider: "jira",
  async listProjects(cred, f) {
    const site = jiraSite(cred.site);
    const out = [];
    for (let startAt = 0; startAt < 5000; startAt += 50) {
      const r = await readJson<{ values: { id: string; key: string; name: string }[]; isLast: boolean }>(
        "jira",
        await f(`${site}/rest/api/3/project/search?startAt=${startAt}&maxResults=50`, { headers: headers(cred) }),
      );
      out.push(...r.values.map((p) => ({ id: p.id, name: p.name, key: p.key })));
      if (r.isLast || !r.values.length) break;
    }
    return out;
  },
  async fetchTasks(cred, projectIds, since, f) {
    if (!projectIds.length) return [];
    const site = jiraSite(cred.site);
    const jql = `project in (${projectIds
      .map((id) => Number(id))
      .filter(Number.isFinite)
      .join(",")})${since ? ` AND updated >= "${jqlDate(new Date(since.getTime() - 60_000))}"` : ""} ORDER BY updated ASC`;
    const out: ExternalTask[] = [];
    let next: string | null = null;
    for (let i = 0; i < 500; i++) {
      const body: Record<string, unknown> = { jql, maxResults: 100, fields: ["summary", "status", "assignee", "created", "updated", "resolutiondate", "duedate", "project"] };
      if (next) body.nextPageToken = next;
      const r: { issues: Issue[]; nextPageToken?: string | null; isLast?: boolean } = await readJson(
        "jira",
        await f(`${site}/rest/api/3/search/jql`, { method: "POST", headers: headers(cred), body: JSON.stringify(body) }),
      );
      for (const it of r.issues) {
        const status = jiraStatus(it.fields.status);
        out.push({
          id: it.id,
          key: it.key.toUpperCase(),
          title: it.fields.summary || "(untitled)",
          url: `${site}/browse/${it.key}`,
          projectId: it.fields.project.id,
          assigneeEmail: it.fields.assignee?.emailAddress ?? null,
          status,
          createdAt: it.fields.created,
          startedAt: null,
          completedAt: status === "done" ? it.fields.resolutiondate : null,
          dueAt: dueFrom(it.fields.duedate),
          updatedAt: it.fields.updated,
        });
      }
      next = r.nextPageToken ?? null;
      if (r.isLast || !next || !r.issues.length) break;
    }
    return out;
  },
};
