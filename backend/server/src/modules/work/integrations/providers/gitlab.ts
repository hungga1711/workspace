import { defineIntegration, IntegrationError, okJson, type Card, type ProviderContext } from "../define.js";

/**
 * GitLab: merge requests and issues, on gitlab.com or the company's own GitLab (the admin gives its address). A merge
 * request's card carries its state, branches, approvals and its pipeline. Token: a personal, group or project access
 * token with `read_api`.
 */
const headers = (ctx: ProviderContext) => ({ "private-token": ctx.token, accept: "application/json", "user-agent": "workspace-hub" });
const project = (path: string) => encodeURIComponent(path);

interface MergeRequest {
  title: string;
  web_url: string;
  state: "opened" | "closed" | "merged" | "locked";
  draft?: boolean;
  work_in_progress?: boolean;
  author?: { name: string; username: string } | null;
  updated_at: string;
  source_branch: string;
  target_branch: string;
  user_notes_count?: number;
  labels?: string[];
  changes_count?: string | null;
  reviewers?: { name: string; username: string }[];
  head_pipeline?: { status: string } | null;
  pipeline?: { status: string } | null;
}

export const gitlab = defineIntegration({
  id: "gitlab",
  name: "GitLab",
  category: "development",
  summary: "Merge requests and issues on the tasks they belong to, with their state, approvals and pipeline.",
  webBase: "https://gitlab.com",
  apiBase: "https://gitlab.com/api/v4",
  selfHosted: { apiPath: "/api/v4" },
  tokenHelp: {
    url: "https://docs.gitlab.com/user/profile/personal_access_tokens/",
    needs: "An access token with the read_api scope, of an account that can see the projects to show",
  },
  match(url, webBase) {
    if (url.origin !== webBase) return null;
    // Groups nest, so the project is everything before "/-/".
    const m = /^\/(.+?)\/-\/(merge_requests|issues)\/(\d+)/.exec(url.pathname);
    if (!m) return null;
    const [, path, what, iid] = m as unknown as [string, string, string, string];
    const mr = what === "merge_requests";
    return { key: `${path}${mr ? "!" : "#"}${iid}`.toLowerCase(), kind: mr ? "review" : "issue", data: { path, iid } };
  },
  async fetch(ref, ctx) {
    const { path, iid } = ref.data as { path: string; iid: string };
    const base = `${ctx.apiBase}/projects/${project(path)}`;
    if (ref.kind === "issue") {
      const i = okJson<{ title: string; state: string; author?: { name: string } | null; updated_at: string; user_notes_count?: number; labels?: string[] }>(
        "GitLab",
        await ctx.request(`${base}/issues/${iid}`, { headers: headers(ctx) }),
      );
      return {
        kind: "issue",
        title: i.title,
        ref: `${path}#${iid}`,
        state: i.state === "opened" ? "open" : "done",
        author: i.author?.name,
        updatedAt: i.updated_at,
        comments: i.user_notes_count,
        labels: i.labels,
      };
    }
    const m = okJson<MergeRequest>("GitLab", await ctx.request(`${base}/merge_requests/${iid}`, { headers: headers(ctx) }));
    // Approvals add to the card but never fail it (the endpoint needs a paid tier on some installations).
    const approvals = await ctx
      .request(`${base}/merge_requests/${iid}/approvals`, { headers: headers(ctx) })
      .then((r) => (r.status === 200 ? r.json<{ approved_by?: { user: { name: string; username: string } }[] }>() : null));
    const approved = new Set((approvals?.approved_by ?? []).map((a) => a.user.username));
    const names = new Map<string, string>([...(m.reviewers ?? []), ...(approvals?.approved_by ?? []).map((a) => a.user)].map((u) => [u.username, u.name]));
    const card: Card = {
      kind: "review",
      title: m.title,
      ref: `${path}!${iid}`,
      state: m.state === "merged" ? "merged" : m.state === "closed" ? "closed" : m.draft || m.work_in_progress ? "draft" : "open",
      author: m.author?.name,
      updatedAt: m.updated_at,
      branch: m.source_branch,
      target: m.target_branch,
      comments: m.user_notes_count,
      labels: m.labels,
      reviewers: [...names].map(([username, name]) => ({ name, state: approved.has(username) ? ("approved" as const) : ("pending" as const) })),
      checks: gitlabChecks((m.head_pipeline ?? m.pipeline)?.status),
    };
    return card;
  },
  async check(ctx) {
    const me = okJson<{ username: string }>("GitLab", await ctx.request(`${ctx.apiBase}/user`, { headers: headers(ctx) }));
    return { account: me.username };
  },
  async listRepos(ctx) {
    const rows = okJson<{ path_with_namespace: string }[]>(
      "GitLab",
      await ctx.request(`${ctx.apiBase}/projects?membership=true&simple=true&order_by=last_activity_at&per_page=100`, { headers: headers(ctx) }),
    );
    return rows.map((r) => ({ id: r.path_with_namespace, name: r.path_with_namespace }));
  },
  async recentReviews(repo, since, ctx) {
    if (!/^[\w.-]+(\/[\w.-]+)+$/.test(repo)) throw new IntegrationError(`"${repo}" is not a project (group/name)`);
    const after = since ? `&updated_after=${encodeURIComponent(since.toISOString())}` : "";
    const rows = okJson<MergeRequest[]>(
      "GitLab",
      await ctx.request(`${ctx.apiBase}/projects/${project(repo)}/merge_requests?state=all&order_by=updated_at&sort=desc&per_page=100${after}`, { headers: headers(ctx) }),
    );
    return rows.map((m) => ({ url: m.web_url, title: m.title, branch: m.source_branch, updatedAt: m.updated_at }));
  },
});

/** A pipeline's status in the card's three words; absent when there is no pipeline or it was skipped. */
export function gitlabChecks(status: string | undefined): Card["checks"] {
  if (!status) return undefined;
  if (status === "success") return "passing";
  if (status === "failed" || status === "canceled") return "failing";
  if (["running", "pending", "created", "waiting_for_resource", "preparing", "scheduled", "manual"].includes(status)) return "pending";
  return undefined;
}
