import { defineIntegration, IntegrationError, okJson, type Card, type ProviderContext } from "../define.js";

/**
 * GitHub: pull requests and issues. A pull request's card carries its state (open, draft, merged, closed), its
 * branches, size, reviews and whether its checks pass. Token: a fine-grained personal access token (or a classic one
 * with `repo`) of an account that can read the repositories.
 */
const headers = (ctx: ProviderContext) => ({
  authorization: `Bearer ${ctx.token}`,
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "workspace-hub",
});

interface Pull {
  title: string;
  html_url: string;
  state: "open" | "closed";
  draft?: boolean;
  merged?: boolean;
  merged_at?: string | null;
  user?: { login: string } | null;
  updated_at: string;
  additions?: number;
  deletions?: number;
  comments?: number;
  review_comments?: number;
  head: { ref: string; sha: string };
  base: { ref: string };
  labels?: { name: string }[];
  requested_reviewers?: { login: string }[];
}
interface Review {
  user?: { login: string } | null;
  state: string;
}

export const github = defineIntegration({
  id: "github",
  name: "GitHub",
  category: "development",
  summary: "Pull requests and issues on the tasks they belong to, with their state, reviews and checks.",
  webBase: "https://github.com",
  apiBase: "https://api.github.com",
  tokenHelp: {
    url: "https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens",
    needs: "A fine-grained token with read access to Pull requests, Issues, Commit statuses and Metadata on the repositories to show",
  },
  match(url, webBase) {
    if (url.origin !== webBase) return null;
    const m = /^\/([\w.-]+)\/([\w.-]+)\/(pull|issues)\/(\d+)/.exec(url.pathname);
    if (!m) return null;
    const [, owner, repo, what, number] = m as unknown as [string, string, string, string, string];
    return { key: `${owner}/${repo}#${number}`.toLowerCase(), kind: what === "pull" ? "review" : "issue", data: { owner, repo, number } };
  },
  async fetch(ref, ctx) {
    const { owner, repo, number } = ref.data as { owner: string; repo: string; number: string };
    const base = `${ctx.apiBase}/repos/${owner}/${repo}`;
    const name = `${owner}/${repo}#${number}`;
    if (ref.kind === "issue") {
      const i = okJson<{
        title: string;
        state: string;
        state_reason?: string | null;
        user?: { login: string } | null;
        updated_at: string;
        comments?: number;
        labels?: { name: string }[];
      }>("GitHub", await ctx.request(`${base}/issues/${number}`, { headers: headers(ctx) }));
      return {
        kind: "issue",
        title: i.title,
        ref: name,
        state: i.state === "open" ? "open" : i.state_reason === "completed" ? "done" : "closed",
        author: i.user?.login,
        updatedAt: i.updated_at,
        comments: i.comments,
        labels: i.labels?.map((l) => l.name),
      };
    }
    const p = okJson<Pull>("GitHub", await ctx.request(`${base}/pulls/${number}`, { headers: headers(ctx) }));
    // Reviews and checks add to the card but never fail it: a token without those permissions still shows the rest.
    const [reviews, status] = await Promise.all([
      ctx.request(`${base}/pulls/${number}/reviews?per_page=100`, { headers: headers(ctx) }).then((r) => (r.status === 200 ? (r.json<Review[]>() ?? []) : [])),
      p.state === "open"
        ? ctx
            .request(`${base}/commits/${p.head.sha}/check-runs?per_page=100`, { headers: headers(ctx) })
            .then((r) => (r.status === 200 ? r.json<{ check_runs: { status: string; conclusion: string | null }[] }>() : null))
        : Promise.resolve(null),
    ]);
    const card: Card = {
      kind: "review",
      title: p.title,
      ref: name,
      state: p.merged || p.merged_at ? "merged" : p.state === "closed" ? "closed" : p.draft ? "draft" : "open",
      author: p.user?.login,
      updatedAt: p.updated_at,
      branch: p.head.ref,
      target: p.base.ref,
      additions: p.additions,
      deletions: p.deletions,
      comments: (p.comments ?? 0) + (p.review_comments ?? 0),
      labels: p.labels?.map((l) => l.name),
      reviewers: githubReviewers(reviews, p.requested_reviewers ?? []),
      checks: githubChecks(status?.check_runs),
    };
    return card;
  },
  async check(ctx) {
    const me = okJson<{ login: string }>("GitHub", await ctx.request(`${ctx.apiBase}/user`, { headers: headers(ctx) }));
    return { account: me.login };
  },
  async listRepos(ctx) {
    const out: { id: string; name: string }[] = [];
    for (let page = 1; page <= 5; page++) {
      const rows = okJson<{ full_name: string }[]>("GitHub", await ctx.request(`${ctx.apiBase}/user/repos?per_page=100&sort=pushed&page=${page}`, { headers: headers(ctx) }));
      out.push(...rows.map((r) => ({ id: r.full_name, name: r.full_name })));
      if (rows.length < 100) break;
    }
    return out;
  },
  async recentReviews(repo, since, ctx) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new IntegrationError(`"${repo}" is not a repository (owner/name)`);
    const rows = okJson<Pull[]>("GitHub", await ctx.request(`${ctx.apiBase}/repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=100`, { headers: headers(ctx) }));
    return rows.filter((p) => !since || Date.parse(p.updated_at) > since.getTime()).map((p) => ({ url: p.html_url, title: p.title, branch: p.head.ref, updatedAt: p.updated_at }));
  },
});

/** Each person's latest verdict; someone asked again after reviewing waits again. */
export function githubReviewers(reviews: Review[], requested: { login: string }[]) {
  const by = new Map<string, "approved" | "changes" | "pending">();
  for (const r of reviews) {
    const who = r.user?.login;
    if (!who) continue;
    if (r.state === "APPROVED") by.set(who, "approved");
    else if (r.state === "CHANGES_REQUESTED") by.set(who, "changes");
    else if (r.state === "DISMISSED") by.set(who, "pending");
    else if (!by.has(who) && r.state === "COMMENTED") by.set(who, "pending");
  }
  for (const r of requested) by.set(r.login, "pending");
  return [...by].map(([name, state]) => ({ name, state }));
}

/** One word for all the checks: failing if any failed, pending while any runs, passing when all are through. */
export function githubChecks(runs: { status: string; conclusion: string | null }[] | undefined): Card["checks"] {
  if (!runs?.length) return undefined;
  if (runs.some((r) => ["failure", "timed_out", "cancelled", "action_required", "startup_failure"].includes(r.conclusion ?? ""))) return "failing";
  if (runs.some((r) => r.status !== "completed")) return "pending";
  return "passing";
}
