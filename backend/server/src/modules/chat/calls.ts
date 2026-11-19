import { Body, Controller, Get, HttpCode, HttpException, Inject, NotFoundException, Param, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { newId, runWithContext, withTransaction, type Principal } from "@workspace/shared";
import { assertAllowed, kv, logger, PRINCIPAL_HEADER, requirePrincipal, serviceFetch, signInternalToken } from "@workspace/service-kit";
import { openDm, postMessage } from "./domain.js";
import type { Realtime } from "./realtime.js";

export const CALLS_DEPS = Symbol("CALLS_DEPS");
export interface CallsDeps {
  pool: Pool;
  rt: Realtime;
  workUrl: string;
  internalSecret: string;
}

/**
 * One-to-one calls: the person called hears it ring wherever they are in the app, and answers or declines.
 * Ringing is signalling only: the call itself is a LiveKit room (work module),
 * made private to the two and tied to their DM, so the DM shows "join" while it lasts and keeps the record:
 * missed, declined, or how long it lasted.
 *
 * A call lives in the server's memory (no table; a restart ends calls ringing, the LiveKit room carries on):
 * ringing → accepted → ended, or ringing → declined | missed | cancelled. Every change is a compare-and-set with
 * no await in between, so two devices answering at once, or the ring timing out while answered, settle on one
 * outcome.
 */
export type CallState = "ringing" | "accepted" | "declined" | "missed" | "cancelled" | "ended";
export interface Call {
  id: string;
  from: string;
  to: string;
  video: boolean;
  code: string;
  channelId: string;
  state: CallState;
  startedAt: number;
  acceptedAt?: number;
  endedAt?: number;
}

// How long it rings before it is a missed call (shorter in tests).
const ringMs = () => Number(process.env.CALL_RING_MS ?? 30_000);
const KEEP_S = 4 * 3600;
const key = (id: string) => `call:${id}`;
const line = (userId: string) => `line:${userId}`;

const store = kv();
// Frees a person's line only if it is still held by this call.
const free1 = (userId: string, callId: string) => {
  if (store.get(line(userId)) === callId) store.del(line(userId));
};

const fmtDuration = (ms: number, en: boolean) => {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return en ? `${s} s` : `${s} giây`;
  const m = Math.floor(s / 60);
  if (m < 60) return en ? `${m} min` : `${m} phút`;
  return en ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.floor(m / 60)} giờ ${m % 60} phút`;
};

/** The line the DM keeps for each outcome, in the language of whoever caused it. */
export function callNote(c: Call, outcome: "missed" | "declined" | "ended", en: boolean): string {
  const kind = c.video ? (en ? "Video call" : "Cuộc gọi video") : en ? "Voice call" : "Cuộc gọi thoại";
  if (outcome === "ended") return `📞 ${kind} · ${fmtDuration((c.endedAt ?? Date.now()) - (c.acceptedAt ?? c.startedAt), en)}`;
  if (outcome === "declined") return en ? `📞 ${kind} declined` : `📞 ${kind} bị từ chối`;
  return en ? `📞 Missed ${kind.toLowerCase()}` : `📞 ${kind} nhỡ`;
}

const dto = (c: Call) => ({
  id: c.id,
  from: c.from,
  to: c.to,
  video: c.video,
  code: c.code,
  channelId: c.channelId,
  state: c.state,
  startedAt: c.startedAt,
  acceptedAt: c.acceptedAt ?? null,
});

@Controller()
export class CallsController {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(@Inject(CALLS_DEPS) private readonly d: CallsDeps) {}

  private async load(p: Principal, id: string): Promise<Call> {
    if (!/^[0-9A-Z]{26}$/.test(id)) throw new NotFoundException("call not found");
    const raw = store.get(key(id));
    const c = raw ? (JSON.parse(raw) as Call) : null;
    // Only the two people on the call know it exists.
    if (!c || (c.from !== p.id && c.to !== p.id)) throw new NotFoundException("call not found");
    return c;
  }

  private async move(c: Call, from: CallState, to: CallState, stamp: "acceptedAt" | "endedAt"): Promise<Call | null> {
    const raw = store.get(key(c.id));
    const cur = raw ? (JSON.parse(raw) as Call) : null;
    if (!cur || cur.state !== from) return null;
    const next: Call = { ...cur, state: to, [stamp]: Date.now() };
    store.set(key(c.id), JSON.stringify(next), { keepTtl: true });
    return next;
  }

  private async free(c: Call) {
    for (const u of [c.from, c.to]) free1(u, c.id);
  }

  /** Both people's devices hear every change (the caller's call screen, the other tabs of the person called). */
  private tell(c: Call, event: string) {
    for (const u of [c.from, c.to]) this.d.rt.toUser(u, event, dto(c));
  }

  /** The record in their DM, posted by whoever it is about. */
  private async note(c: Call, author: string, body: string) {
    const out = await runWithContext({ actorId: `user:${author}`, requestId: newId() }, () =>
      withTransaction(this.d.pool, (pg) =>
        postMessage(pg, { channelId: c.channelId, body, clientMsgId: `call:${c.id}`, threadRootId: null, attachments: [], author: { id: author, type: "user" } }),
      ),
    );
    if (out.created) this.d.rt.toChannel(c.channelId, "message.created", out.message);
  }

  private async finish(c: Call, outcome: "missed" | "declined" | "cancelled" | "ended", en: boolean) {
    clearTimeout(this.timers.get(c.id));
    this.timers.delete(c.id);
    await this.free(c);
    this.tell(c, `call:${outcome}`);
    const note = outcome === "cancelled" ? "missed" : outcome;
    await this.note(c, outcome === "declined" ? c.to : c.from, callNote(c, note, en)).catch((err) => logger.warn({ err }, "call note failed"));
  }

  private async asUser<T>(p: Principal, method: string, path: string, body?: unknown): Promise<T> {
    const res = await serviceFetch(`${this.d.workUrl}${path}`, {
      method,
      signal: AbortSignal.timeout(5000),
      headers: { "content-type": "application/json", [PRINCIPAL_HEADER]: await signInternalToken({ principal: p, requestId: newId() }, this.d.internalSecret) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) throw new HttpException("could not open the call room", 502);
    return (await res.json()) as T;
  }

  @Post("calls")
  async start(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "message.post");
    const b = z.object({ userId: z.string().min(1).max(64), video: z.boolean().default(false) }).safeParse(body);
    if (!b.success || b.data.userId === p.id) throw new HttpException("pick someone else to call", 400);
    // A runaway client cannot ring people in a loop.
    const rate = `callrate:${p.id}`;
    if (store.incr(rate, 60_000) > 15) throw new HttpException("too many calls, try again in a minute", 429);

    const { dm, dnd } = await withTransaction(this.d.pool, async (pg) => ({
      dm: await openDm(pg, p, b.data.userId),
      // Do not disturb means no ringing; the caller is told, and can still write.
      dnd: (await pg.query("SELECT 1 FROM user_status WHERE user_id = $1 AND dnd_until > now()", [b.data.userId])).rowCount! > 0,
    }));
    if (dnd) throw new HttpException({ error: "dnd", message: "do not disturb" }, 409);
    const id = newId();
    // The person called must be free: not ringing, not on another call.
    const free = store.set(line(b.data.userId), id, { ttlMs: ringMs() + 15_000, nx: true });
    if (!free) throw new HttpException({ error: "busy", message: "on another call" }, 409);
    try {
      const room = await this.asUser<{ code: string }>(p, "POST", "/meet/rooms", { title: b.data.video ? "Cuộc gọi video" : "Cuộc gọi", channelId: dm.id, guestAccess: "off" });
      const c: Call = { id, from: p.id, to: b.data.userId, video: b.data.video, code: room.code, channelId: dm.id, state: "ringing", startedAt: Date.now() };
      store.set(key(id), JSON.stringify(c), { ttlMs: KEEP_S * 1000 });
      store.set(line(p.id), id, { ttlMs: ringMs() + 15_000 });
      const en = req.header("x-locale") !== "vi";
      this.timers.set(
        id,
        setTimeout(() => {
          this.timers.delete(id);
          void this.move(c, "ringing", "missed", "endedAt")
            .then((m) => m && this.finish(m, "missed", en))
            .catch((err) => logger.warn({ err }, "call timeout failed"));
        }, ringMs()),
      );
      this.d.rt.toUser(b.data.userId, "call:ring", dto(c));
      return dto(c);
    } catch (e) {
      free1(b.data.userId, id);
      throw e;
    }
  }

  @Get("calls/:id")
  async get(@Req() req: Request, @Param("id") id: string) {
    return dto(await this.load(requirePrincipal(req), id));
  }

  @Post("calls/:id/accept")
  @HttpCode(200)
  async accept(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    const c = await this.load(p, id);
    if (c.to !== p.id) throw new HttpException("only the person called answers", 403);
    const m = await this.move(c, "ringing", "accepted", "acceptedAt");
    if (!m) throw new HttpException({ error: "gone", state: (await this.load(p, id)).state }, 409);
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    for (const u of [m.from, m.to]) store.set(line(u), m.id, { ttlMs: KEEP_S * 1000 });
    this.tell(m, "call:accepted");
    return dto(m);
  }

  @Post("calls/:id/decline")
  @HttpCode(200)
  async decline(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    const c = await this.load(p, id);
    if (c.to !== p.id) throw new HttpException("only the person called declines", 403);
    const m = await this.move(c, "ringing", "declined", "endedAt");
    if (m) await this.finish(m, "declined", req.header("x-locale") !== "vi");
    return dto(m ?? (await this.load(p, id)));
  }

  /** Hanging up: before an answer it cancels the ring; after, it ends the call for both. */
  @Post("calls/:id/hangup")
  @HttpCode(200)
  async hangup(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    const c = await this.load(p, id);
    const en = req.header("x-locale") !== "vi";
    if (c.state === "ringing" && c.from === p.id) {
      const m = await this.move(c, "ringing", "cancelled", "endedAt");
      if (m) await this.finish(m, "cancelled", en);
      return dto(m ?? (await this.load(p, id)));
    }
    const m = await this.move(c, "accepted", "ended", "endedAt");
    if (m) await this.finish(m, "ended", en);
    return dto(m ?? (await this.load(p, id)));
  }
}
