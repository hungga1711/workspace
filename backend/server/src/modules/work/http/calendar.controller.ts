import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, HttpCode, NotFoundException, Param, Patch, Post, Query, Req } from "@nestjs/common";
import { assertAllowed, parse, requirePrincipal } from "@workspace/service-kit";
import { authorize, runWithContext, withTransaction } from "@workspace/shared";
import type { Request } from "express";
import { calendarEventCreateBody, calendarEventUpdateBody, calendarRespondBody } from "@workspace/contracts";
import { createEvent, deleteEvent, listEvents, respond, updateEvent } from "../calendar.js";
import { createFeed, deleteFeed, feedIcs, feedOwner, hasFeed } from "../feeds.js";

import { WorkControllerBase } from "./base.controller.js";
import { guard, member } from "./common.js";

/** Calendar events and calendar subscriptions (ICS feeds). */
@Controller()
export class CalendarController extends WorkControllerBase {
  // ---- calendar & meetings ----
  @Post("calendar/events")
  async createEvent(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(calendarEventCreateBody, body);
    return guard(() => withTransaction(this.pool, (c) => createEvent(c, p, b)));
  }

  @Get("calendar/events")
  async events(@Req() req: Request, @Query("from") from?: string, @Query("to") to?: string) {
    const p = requirePrincipal(req);
    if (!from || !to || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) throw new BadRequestException("from and to are required ISO dates");
    return guard(() => withTransaction(this.pool, async (c) => ({ events: await listEvents(c, p, from, to) })));
  }

  // ---- calendar subscription (Google Calendar, Outlook, Apple Calendar) ----

  @Get("calendar/feed")
  async feedStatus(@Req() req: Request) {
    const p = member(req);
    return withTransaction(this.pool, async (c) => ({ active: await hasFeed(c, p) }));
  }

  /** A new private link (the old one stops working). Shown once; only its hash is stored. */
  @Post("calendar/feed")
  async newFeed(@Req() req: Request) {
    const p = member(req);
    assertAllowed(p, "calendar.read", { ownerId: p.id });
    return withTransaction(this.pool, async (c) => ({ token: await createFeed(c, p) }));
  }

  @Delete("calendar/feed")
  @HttpCode(204)
  async stopFeed(@Req() req: Request) {
    const p = member(req);
    await withTransaction(this.pool, (c) => deleteFeed(c, p));
  }

  /** The gateway serves subscription links publicly; calendars poll them without signing in. */
  @Get("internal/calendar-feed/:token")
  async feed(@Req() req: Request, @Param("token") token: string) {
    const p = requirePrincipal(req);
    if (p.type !== "service" || !authorize(p, "principal.resolve").allowed) throw new ForbiddenException("gateway only");
    const owner = await withTransaction(this.pool, (c) => feedOwner(c, token));
    if (!owner) throw new NotFoundException("calendar not found");
    const ics = await runWithContext({ actorId: `user:${owner.userId}`, requestId: String(req.requestId ?? "") }, () =>
      withTransaction(this.pool, (c) => feedIcs(c, owner.userId, process.env.APP_URL ?? "http://localhost:3000")),
    );
    return { ics };
  }

  @Post("calendar/events/:id/respond")
  @HttpCode(204)
  async respond(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(calendarRespondBody, body);
    await guard(() => withTransaction(this.pool, (c) => respond(c, p, id, b.response)));
  }

  @Patch("calendar/events/:id")
  async updateEvent(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(calendarEventUpdateBody, body);
    return guard(() => withTransaction(this.pool, (c) => updateEvent(c, p, id, b)));
  }

  @Delete("calendar/events/:id")
  @HttpCode(204)
  async cancelEvent(@Req() req: Request, @Param("id") id: string, @Query("scope") scope?: string) {
    const p = requirePrincipal(req);
    await guard(() => withTransaction(this.pool, (c) => deleteEvent(c, p, id, scope === "following" ? "following" : "one")));
  }
}
