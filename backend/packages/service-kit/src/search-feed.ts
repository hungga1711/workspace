import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import type { Request } from "express";
import type { Pool, PoolClient } from "pg";
import type { EventPayloadInput, EventType } from "@workspace/contracts";
import { authorize, runWithContext, withTransaction, type Principal } from "@workspace/shared";
import { requirePrincipal } from "./nest.js";

/**
 * Search re-index feed (docs/runbooks/operations.md#rebuild-the-search-index). Each module that feeds search
 * answers `GET /internal/search-feed/:kind` with its current rows written as the events the search indexer already
 * understands, built by the same payload functions its producers use, so a rebuilt index is exactly what live
 * indexing would have produced. Read-only; operators' tools only.
 */
export const SEARCH_REINDEX_PERMISSION = "search.reindex";

export interface FeedEvent<T extends EventType = EventType> {
  eventType: T;
  aggregateType: string;
  aggregateId: string;
  occurredAt: string;
  payload: EventPayloadInput<T>;
}
export interface FeedPage {
  events: FeedEvent[];
  /** Cursor for the next page (the last row's id), null at the end. */
  next: string | null;
}
/** One page of rows with id > after, in id order. */
export type FeedSource = (c: PoolClient, after: string, limit: number) => Promise<FeedPage>;

export const feedEvent = <T extends EventType>(eventType: T, aggregateType: string, aggregateId: string, occurredAt: Date | string, payload: EventPayloadInput<T>): FeedEvent =>
  ({ eventType, aggregateType, aggregateId, occurredAt: new Date(occurredAt).toISOString(), payload }) as FeedEvent;

/** Pages end when a page comes back short. */
export const page = (events: FeedEvent[], lastId: string | undefined, limit: number): FeedPage => ({ events, next: events.length >= limit && lastId ? lastId : null });

/** Internal endpoints for operators' tools: a service principal holding the PLATFORM-scoped permission. */
function requireServicePermission(req: Request, permission: string): Principal {
  const p = requirePrincipal(req);
  if (p.type !== "service" || !authorize(p, permission).allowed) throw new ForbiddenException("platform service required");
  return p;
}

function feedQuery(raw: unknown): { after: string; limit: number } {
  const q = (raw ?? {}) as Record<string, unknown>;
  const after = typeof q.after === "string" ? q.after : "";
  const limit = q.limit === undefined ? 500 : Number(q.limit);
  if (after.length > 128 || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new BadRequestException("after (a cursor) and limit (1-1000) are expected");
  }
  return { after, limit };
}

export async function readSearchFeed(req: Request, pool: Pool, sources: Record<string, FeedSource>, kind: string, raw: unknown): Promise<FeedPage> {
  const p = requireServicePermission(req, SEARCH_REINDEX_PERMISSION);
  const source = Object.prototype.hasOwnProperty.call(sources, kind) ? sources[kind] : undefined;
  if (typeof source !== "function") throw new NotFoundException(`no search feed "${kind}"`);
  const q = feedQuery(raw);
  return runWithContext({ actorId: `service:${p.id}`, requestId: req.requestId ?? "search-feed" }, () => withTransaction(pool, (c) => source(c, q.after, q.limit)));
}
