import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { z } from "zod";
import { Forbidden, Invalid, NotFound } from "../domain.js";

export const POOL = Symbol("POOL");
export const REALTIME = Symbol("REALTIME");
export const SEARCH = Symbol("SEARCH");
export const STORAGE = Symbol("STORAGE");
export const CFG = Symbol("CFG");
export interface ChatCfg {
  workUrl: string;
  internalSecret: string;
}

/** Maps domain errors to HTTP without leaking whether a hidden channel exists. */
export async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof NotFound) throw new NotFoundException(e.message);
    if (e instanceof Forbidden) throw new ForbiddenException(e.message);
    if (e instanceof Invalid) throw new BadRequestException(e.message);
    throw e;
  }
}

export const attachment = z.object({
  fileId: z.string().length(26),
  name: z.string().min(1).max(255),
  size: z.number().int().nonnegative(),
  contentType: z.string().min(1).max(127),
});

/** Display info for channels in cross-channel lists (threads, mentions): DMs are named after the other person on the client. */
export async function channelNames(
  c: import("pg").PoolClient,
  ids: string[],
  viewerId: string,
): Promise<Record<string, { id: string; kind: string; name: string | null; dmUserId: string | null }>> {
  if (!ids.length) return {};
  const r = await c.query<{ id: string; kind: string; name: string | null; dmUserId: string | null }>(
    `SELECT ch.id, ch.kind, ch.name, CASE WHEN ch.kind = 'dm' THEN (SELECT user_id FROM channel_members o WHERE o.channel_id = ch.id AND o.user_id <> $2 LIMIT 1) END AS "dmUserId"
       FROM channels ch WHERE ch.id = ANY($1)`,
    [ids, viewerId],
  );
  return Object.fromEntries(r.rows.map((x) => [x.id, x]));
}
