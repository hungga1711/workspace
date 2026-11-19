import { join } from "node:path";
import { env, migrate, moduleUrl, SEARCH_REINDEX_PERMISSION, searchPool, ServiceClient, type ModuleContext } from "@workspace/service-kit";
import { startIndexer, type FetchKnowledge } from "./indexer.js";

/** Search: indexes domain events into the `search` schema (no HTTP API; chat reads it, `reindex` rebuilds it). */
export async function startSearch(ctx: ModuleContext): Promise<void> {
  await migrate(ctx.ownerUrl, join(ctx.migrations, "search"), "search");
  const pool = searchPool(env("SEARCH_DATABASE_URL", "postgres://workspace_search:app_pw@localhost:5432/workspace"));
  // The text behind passages (a task with its comments, a meeting's minutes, a file's words) is read from the work
  // module when an event says it changed; files can be long, so the call may take a while.
  const work = new ServiceClient(
    moduleUrl("work"),
    env("INTERNAL_TOKEN_SECRET", "dev-internal-secret-change-me-32bytes!"),
    "search",
    [{ permission: SEARCH_REINDEX_PERMISSION, scope: "PLATFORM" }],
    {
      timeoutMs: 30_000,
    },
  );
  const fetch: FetchKnowledge = (items) => work.request("POST", "/internal/knowledge", { items });
  await startIndexer(ctx.bus, pool, "search-indexer", fetch);
}
