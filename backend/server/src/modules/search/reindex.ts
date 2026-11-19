import type { Pool, PoolClient } from "pg";
import { checkEvent, type EventEnvelope } from "@workspace/contracts";
import { indexDocs, type FeedPage, type KnowledgeDoc, type SearchDoc } from "@workspace/service-kit";
import { runWithContext, withTransaction } from "@workspace/shared";
import { know, toActions } from "./indexer.js";

/**
 * Rebuilds the search schema from the owning modules' tables (after a restore, lost or damaged search data, or a
 * change to what is indexed). Each owning module pages its rows out as the events live indexing understands
 * (service-kit search-feed.ts); this runs them through the same toActions() and writes the result in batches. The
 * event bus is not involved, so nothing is limited by outbox retention and nobody gets notified.
 */
const FEEDS: { service: "identity" | "chat" | "work"; kind: string }[] = [
  { service: "identity", kind: "members" },
  { service: "chat", kind: "channels" },
  { service: "chat", kind: "messages" },
  { service: "work", kind: "projects" },
  { service: "work", kind: "tasks" },
  { service: "work", kind: "documents" },
  { service: "work", kind: "whiteboards" },
  // The text behind AI retrieval's passages (work/knowledge.ts): each event carries one thing's whole text.
  { service: "work", kind: "knowledge-tasks" },
  { service: "work", kind: "knowledge-documents" },
  { service: "work", kind: "knowledge-meetings" },
  { service: "work", kind: "knowledge-events" },
  { service: "work", kind: "knowledge-approvals" },
  { service: "work", kind: "knowledge-files" },
];

export type FetchPage = (service: (typeof FEEDS)[number]["service"], kind: string, after: string) => Promise<FeedPage>;

export interface ReindexOptions {
  pool: Pool;
  fetchPage: FetchPage;
  /** Also rebuild the vocabulary (typo correction) from scratch, forgetting words of deleted rows. */
  recreate?: boolean;
  log?: (line: string) => void;
}

export interface ReindexResult {
  indexed: Record<string, number>;
  skipped: number;
}

export async function reindex(opts: ReindexOptions): Promise<ReindexResult> {
  const log = opts.log ?? (() => undefined);
  const requestId = `reindex-${Date.now()}`;
  const tx = <T>(fn: (c: PoolClient) => Promise<T>) => runWithContext({ actorId: "service:search-reindex", requestId }, () => withTransaction(opts.pool, fn));
  // Documents of rows deleted since they were indexed must go: the index starts from empty. Search is incomplete
  // until the run finishes (seconds to minutes for most companies).
  await tx(async (c) => {
    await c.query("DELETE FROM search_documents");
    await c.query("DELETE FROM search_passages");
    if (opts.recreate) await c.query("DELETE FROM search_terms");
  });
  const result: ReindexResult = { indexed: {}, skipped: 0 };
  for (const feed of FEEDS) {
    let after = "";
    let n = 0;
    for (;;) {
      const pageOut = await opts.fetchPage(feed.service, feed.kind, after);
      const docs: SearchDoc[] = [];
      const known: KnowledgeDoc[] = [];
      for (const fe of pageOut.events) {
        let e: EventEnvelope;
        try {
          // Same validation as live consumption: a row that would not make a valid event is skipped.
          e = { eventId: fe.aggregateId, version: 1, actorId: "service:search-reindex", ...fe, payload: checkEvent(fe) };
        } catch (err) {
          result.skipped++;
          log(`skipped ${fe.eventType} ${fe.aggregateId}: ${(err as Error).message}`);
          continue;
        }
        for (const a of toActions(e)) {
          if (a.op === "index") docs.push(a.doc);
          // The knowledge feeds carry each thing's text; "pull" (live indexing asking for it) has nothing to do here.
          else if (a.op === "know") known.push(a.doc);
        }
      }
      if (docs.length) await tx((c) => indexDocs(c, docs));
      if (known.length)
        await tx(async (c) => {
          for (const doc of known) await know(c, doc);
        });
      n += docs.length + known.length;
      if (!pageOut.next) break;
      after = pageOut.next;
    }
    result.indexed[`${feed.service}.${feed.kind}`] = n;
    log(`${feed.service}.${feed.kind}: ${n}`);
  }
  return result;
}
