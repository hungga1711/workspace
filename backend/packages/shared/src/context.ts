import { AsyncLocalStorage } from "node:async_hooks";

/** Who is acting and for which request: bound at the request boundary (or per event and job), read by audit and logs. */
export interface RequestContext {
  actorId: string;
  requestId: string;
  /** Where the request came from (signed by the gateway): carried on events for the audit trail (ADR 0025). */
  origin?: RequestOrigin | undefined;
}

export interface RequestOrigin {
  ip?: string | undefined;
  userAgent?: string | undefined;
  /** The credential kind: "session", "personal_key", "workspace_key" or "oauth". */
  via?: string | undefined;
}

export class MissingRequestContextError extends Error {
  constructor() {
    super("No request context: call runWithContext() at the request boundary");
    this.name = "MissingRequestContextError";
  }
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Binds the actor and request id for the duration of fn. The actor comes from the verified principal, never client input. */
export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getRequestContext(): RequestContext {
  const ctx = storage.getStore();
  if (!ctx) throw new MissingRequestContextError();
  return ctx;
}

/** The context when there is one (jobs, the gateway and public routes run without). */
export function maybeRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Request id for work that has no actor (the gateway, public routes, jobs, the search indexer). Inside
 * runWithContext the context's id wins.
 */
const requestIdStorage = new AsyncLocalStorage<{ requestId: string }>();

export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return requestIdStorage.run({ requestId }, fn);
}

/** Drops empty fields and clips to the envelope's limits; undefined when nothing is known. */
export function cleanOrigin(o: RequestOrigin | null | undefined): RequestOrigin | undefined {
  if (!o) return undefined;
  const out: RequestOrigin = {};
  if (o.ip) out.ip = String(o.ip).slice(0, 64);
  if (o.userAgent) out.userAgent = String(o.userAgent).slice(0, 300);
  if (o.via) out.via = String(o.via).slice(0, 32);
  return Object.keys(out).length ? out : undefined;
}

export function currentRequestId(): string | undefined {
  return maybeRequestContext()?.requestId ?? requestIdStorage.getStore()?.requestId;
}
