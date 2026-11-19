import { ForbiddenException, Inject, NotFoundException } from "@nestjs/common";
import { requirePrincipal, type ObjectStorage, type ServiceClient } from "@workspace/service-kit";
import { authorize, runWithContext, withTransaction } from "@workspace/shared";
import type { Request } from "express";
import type { Pool } from "pg";
import { seesEveryone, type Person } from "../followup.js";
import { roomExists, type MeetConfig } from "../rooms.js";

import { AI, EMPLOYEE, guard, MEET, POOL, STORAGE } from "./common.js";

/**
 * What every Work controller shares: the injected dependencies and two helpers (the caller's reporting line,
 * and running a guest meeting request for an existing room). Controllers extend it and
 * inherit the constructor, so Nest injects the same tokens into each.
 */
export abstract class WorkControllerBase {
  constructor(
    @Inject(POOL) protected readonly pool: Pool,
    @Inject(STORAGE) protected readonly storage: ObjectStorage,
    @Inject(MEET) protected readonly meet: MeetConfig | null,
    @Inject(EMPLOYEE) protected readonly employee: ServiceClient,
    @Inject(AI) protected readonly ai: ServiceClient,
  ) {}

  /** LiveKit, or 404 when this server has no video meetings (`LIVEKIT_URL` unset; the web hides every entry point). */
  protected get livekit(): MeetConfig {
    if (!this.meet) throw new NotFoundException({ error: "meet_not_configured", message: "video meetings are not configured on this server" });
    return this.meet;
  }

  /** The caller's reporting line, asked of the employee module as the caller (it cannot be widened here). */
  protected async myPeople(p: import("@workspace/shared").Principal): Promise<{ scope: "reports" | "everyone" | "none"; people: Person[] }> {
    const r = await this.employee.request<{ reports: Person[] }>("GET", "/me/reports", undefined, p).catch(() => ({ reports: [] as Person[] }));
    if (r.reports.length) return { scope: "reports", people: r.reports };
    if (!seesEveryone(p)) return { scope: "none", people: [] };
    const all = await this.employee.request<{ employees: Person[] }>("GET", "/employees?all=1", undefined, p).catch(() => ({ employees: [] as Person[] }));
    return { scope: "everyone", people: all.employees };
  }

  // Guests (anyone with the link). Only the gateway calls these, for its public /api/meet routes; the link's code
  // must name a room before anything else runs.
  protected async asRoomGuest<T>(req: Request, code: string, fn: (c: import("pg").PoolClient) => Promise<T>): Promise<T> {
    const p = requirePrincipal(req);
    if (p.type !== "service" || !authorize(p, "principal.resolve").allowed) throw new ForbiddenException("gateway only");
    if (!(await withTransaction(this.pool, (c) => roomExists(c, code)))) throw new NotFoundException("meeting not found");
    return guard(() => runWithContext({ actorId: "guest", requestId: String(req.requestId ?? "") }, () => withTransaction(this.pool, fn)));
  }
}
