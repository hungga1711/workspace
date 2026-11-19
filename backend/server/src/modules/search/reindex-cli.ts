/**
 * Rebuild the search schema from the owning modules (docs/runbooks/operations.md#rebuild-the-search-index).
 *
 *   node dist/reindex-cli.js [--recreate]
 *
 * Needs the running server (it pages rows out of identity, chat and work through their module APIs, `<MODULE>_URL`),
 * INTERNAL_TOKEN_SECRET and SEARCH_DATABASE_URL (the search schema, as its app role). --recreate also rebuilds the
 * typo-correction vocabulary from scratch.
 */
import { type FeedPage, moduleUrl, env, SEARCH_REINDEX_PERMISSION, searchPool, ServiceClient } from "@workspace/service-kit";
import { reindex, type FetchPage } from "./reindex.js";

const args = process.argv.slice(2);
const secret = env("INTERNAL_TOKEN_SECRET", "dev-internal-secret-change-me-32bytes!");
const grants = [{ permission: SEARCH_REINDEX_PERMISSION, scope: "PLATFORM" as const }];
const clients = {
  identity: new ServiceClient(moduleUrl("identity"), secret, "search-reindex", grants, { timeoutMs: 60_000 }),
  chat: new ServiceClient(moduleUrl("chat"), secret, "search-reindex", grants, { timeoutMs: 60_000 }),
  work: new ServiceClient(moduleUrl("work"), secret, "search-reindex", grants, { timeoutMs: 60_000 }),
};
const fetchPage: FetchPage = (service, kind, after) => clients[service].request<FeedPage>("GET", `/internal/search-feed/${kind}?after=${encodeURIComponent(after)}&limit=500`);

try {
  const started = Date.now();
  const result = await reindex({
    pool: searchPool(env("SEARCH_DATABASE_URL", "postgres://workspace_search:app_pw@localhost:5432/workspace"), 4),
    fetchPage,
    recreate: args.includes("--recreate"),
    log: (line) => console.log(line),
  });
  const docs = Object.values(result.indexed).reduce((a, b) => a + b, 0);
  console.log(`Rebuilt the search index: ${docs} documents${result.skipped ? `, ${result.skipped} rows skipped` : ""} in ${Math.round((Date.now() - started) / 1000)}s.`);
  process.exit(0);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
