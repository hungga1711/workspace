import { dueFrom, readJson, statusFromName, type Connector, type ExternalTask, type Fetcher } from "../types.js";

/**
 * Linear (personal API key): teams become projects, issues keep their identifier (ENG-123). State types map directly:
 * backlog/unstarted/triage → todo, started → in progress (or review by name), completed → done, canceled → cancelled.
 */
const API = "https://api.linear.app/graphql";

interface Issue {
  id: string;
  identifier: string;
  title: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  canceledAt: string | null;
  dueDate: string | null;
  state: { type: string; name: string };
  assignee: { email: string } | null;
  team: { id: string };
}

export function linearStatus(state: { type: string; name: string }): ExternalTask["status"] {
  if (state.type === "completed") return "done";
  if (state.type === "canceled") return "cancelled";
  if (state.type === "started") return statusFromName(state.name, "in_progress") === "review" ? "review" : "in_progress";
  return "todo";
}

async function gql<T>(cred: { token: string }, f: Fetcher, query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await f(API, { method: "POST", headers: { Authorization: cred.token, "Content-Type": "application/json" }, body: JSON.stringify({ query, variables }) });
  const body = await readJson<{ data?: T; errors?: { message: string }[] }>("linear", res);
  if (body.errors?.length || !body.data) throw new Error(`Linear: ${body.errors?.[0]?.message ?? "empty answer"}`);
  return body.data;
}

const ISSUES = `query Issues($teams: [ID!], $since: DateTimeOrDuration, $after: String) {
  issues(first: 100, after: $after, orderBy: updatedAt, filter: { team: { id: { in: $teams } }, updatedAt: { gt: $since } }) {
    nodes { id identifier title url createdAt updatedAt startedAt completedAt canceledAt dueDate state { type name } assignee { email } team { id } }
    pageInfo { hasNextPage endCursor }
  }
}`;

export const linear: Connector = {
  provider: "linear",
  async listProjects(cred, f) {
    const d = await gql<{ teams: { nodes: { id: string; name: string; key: string }[] } }>(cred, f, "query { teams(first: 250) { nodes { id name key } } }", {});
    return d.teams.nodes.map((t) => ({ id: t.id, name: t.name, key: t.key }));
  },
  async fetchTasks(cred, projectIds, since, f) {
    const out: ExternalTask[] = [];
    let after: string | null = null;
    for (let i = 0; i < 500; i++) {
      const d: { issues: { nodes: Issue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } = await gql(cred, f, ISSUES, {
        teams: projectIds,
        since: (since ?? new Date(0)).toISOString(),
        after,
      });
      for (const n of d.issues.nodes) {
        const status = linearStatus(n.state);
        out.push({
          id: n.id,
          key: n.identifier.toUpperCase(),
          title: n.title || "(untitled)",
          url: n.url,
          projectId: n.team.id,
          assigneeEmail: n.assignee?.email ?? null,
          status,
          createdAt: n.createdAt,
          startedAt: n.startedAt,
          completedAt: status === "done" ? n.completedAt : null,
          dueAt: dueFrom(n.dueDate),
          updatedAt: n.updatedAt,
        });
      }
      if (!d.issues.pageInfo.hasNextPage) break;
      after = d.issues.pageInfo.endCursor;
    }
    return out;
  },
};
