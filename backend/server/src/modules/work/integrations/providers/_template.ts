import { defineIntegration, okJson, type ProviderContext } from "../define.js";

/**
 * A starting point for a new integration. Copy this file to `<your-id>.ts`, fill it in, add it to `registry.ts`, add
 * recorded answers to `fixtures/<your-id>.json` and a case to `providers.test.ts`. The walk-through is
 * docs/integrations/hub.md › "Write an integration".
 *
 * This one reads issues of an imaginary tracker at https://tracker.example.com/<project>/issues/<number>.
 */
const headers = (ctx: ProviderContext) => ({ authorization: `Bearer ${ctx.token}`, accept: "application/json" });

export const template = defineIntegration({
  // Stored with every connection and link: lower-case, never renamed.
  id: "example-tracker",
  name: "Example Tracker",
  // "development", "design" or "other": the group its tile sits in.
  category: "other",
  summary: "Issues on the tasks they belong to, with their state.",
  webBase: "https://tracker.example.com",
  apiBase: "https://api.tracker.example.com",
  // Uncomment when companies run their own copy; the admin then gives its address, and the API is under this path.
  // selfHosted: { apiPath: "/api/v1" },
  tokenHelp: { url: "https://tracker.example.com/docs/tokens", needs: "A read-only token of an account that can see the projects to show" },

  /** Is this address ours? Return a stable `key` (the same thing must always get the same key) and what `fetch` needs. */
  match(url, webBase) {
    if (url.origin !== webBase) return null;
    const m = /^\/([\w-]+)\/issues\/(\d+)/.exec(url.pathname);
    if (!m) return null;
    return { key: `${m[1]}#${m[2]}`.toLowerCase(), kind: "issue", data: { project: m[1]!, number: m[2]! } };
  },

  /** Read it and return a card. `ctx.request` is the only way out: https, public addresses, no redirects, 1 MB, 10 s. */
  async fetch(ref, ctx) {
    const { project, number } = ref.data as { project: string; number: string };
    const issue = okJson<{ title: string; open: boolean; author: string; updated: string }>(
      "Example Tracker",
      await ctx.request(`${ctx.apiBase}/projects/${project}/issues/${number}`, { headers: headers(ctx) }),
    );
    return { kind: "issue", title: issue.title, ref: `${project}#${number}`, state: issue.open ? "open" : "done", author: issue.author, updatedAt: issue.updated };
  },

  /** Prove the token works and say whose it is: shown to the admin before the connection is saved. */
  async check(ctx) {
    const me = okJson<{ name: string }>("Example Tracker", await ctx.request(`${ctx.apiBase}/me`, { headers: headers(ctx) }));
    return { account: me.name };
  },
});
