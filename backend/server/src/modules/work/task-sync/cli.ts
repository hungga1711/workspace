/**
 * Dry run for a task sync token: lists what the token can read and the first tasks as they would be imported.
 * Nothing is written. From backend/server:
 *
 *   pnpm task-sync:check --provider linear --token lin_api_…
 *   pnpm task-sync:check --provider jira --site acme.atlassian.net --email you@acme.com --token … --project 10001
 *
 * In the production image: node dist/modules/work/task-sync/cli.js (same flags).
 */
import { parseArgs } from "node:util";
import { CONNECTORS } from "./connectors/index.js";
import { PROVIDERS, type Provider } from "./types.js";

const { values } = parseArgs({
  options: {
    provider: { type: "string" },
    token: { type: "string" },
    site: { type: "string" },
    email: { type: "string" },
    project: { type: "string", multiple: true },
    days: { type: "string", default: "30" },
    limit: { type: "string", default: "10" },
  },
});

async function main() {
  const provider = values.provider as Provider | undefined;
  if (!provider || !PROVIDERS.includes(provider) || !values.token) {
    console.error(`usage: --provider ${PROVIDERS.join("|")} --token <token> [--site <jira site>] [--email <jira account>] [--project <id> …] [--days 30] [--limit 10]`);
    process.exit(2);
  }
  const cred = { token: values.token, site: values.site ?? null, email: values.email ?? null };
  const f = (url: string, init?: RequestInit) => fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  const c = CONNECTORS[provider];
  const projects = await c.listProjects(cred, f);
  console.log(`${projects.length} project(s) the token can read:`);
  for (const p of projects) console.log(`  ${p.id}\t${p.key ? `${p.key}\t` : ""}${p.name}`);
  const chosen = values.project?.length ? values.project : projects.slice(0, 1).map((p) => p.id);
  if (!chosen.length) return;
  const since = new Date(Date.now() - Number(values.days) * 86_400_000);
  const tasks = await c.fetchTasks(cred, chosen, since, f);
  console.log(`\n${tasks.length} task(s) updated in the last ${values.days} days in ${chosen.join(", ")}; first ${values.limit}:`);
  for (const t of tasks.slice(0, Number(values.limit))) {
    console.log(`  ${(t.key ?? t.id).padEnd(14)} ${t.status.padEnd(11)} ${(t.assigneeEmail ?? "-").padEnd(28)} ${t.title.slice(0, 60)}`);
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
