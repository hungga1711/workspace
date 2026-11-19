import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Req } from "@nestjs/common";
import { assertAllowed, parse, requirePrincipal } from "@workspace/service-kit";
import { withTransaction } from "@workspace/shared";
import type { Request } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import {
  addLink,
  catalog,
  checkConnection,
  connectionRepos,
  createConnection,
  linkThumbnail,
  listConnections,
  projectReviews,
  refreshLink,
  removeConnection,
  removeLink,
  taskLinks,
  updateConnection,
  type HubDeps,
} from "../integrations/hub.js";
import { resolveRef } from "../ref.js";
import { guard, HUB, POOL } from "./common.js";

const connect = {
  provider: z.string().trim().min(2).max(40),
  token: z.string().trim().min(8).max(500),
  // A self-hosted site (GitLab): its address, and whether it is inside the company's network.
  site: z.string().trim().max(300).nullish(),
  privateNetwork: z.boolean().optional(),
};
const repos = z.array(z.string().trim().min(1).max(200)).max(100);

/**
 * The integrations hub (integrations/hub.ts). The catalogue and a task's linked work are for members (whoever may
 * read the task reads its cards); connections are for people who configure the workspace, like the rest of
 * Admin › Integrations. A token goes in and never comes back.
 */
@Controller()
export class IntegrationsController {
  constructor(
    @Inject(POOL) private readonly pool: Pool,
    @Inject(HUB) private readonly hub: HubDeps,
  ) {}

  private admin(req: Request) {
    const p = requirePrincipal(req);
    assertAllowed(p, "workspace.configure");
    return p;
  }
  private ref(kind: "task" | "project", ref: string) {
    return guard(() => withTransaction(this.pool, (c) => resolveRef(c, kind, ref)));
  }

  @Get("integrations")
  async list(@Req() req: Request) {
    // Which tools the company connected is no secret inside it: any member (their task cards say as much).
    requirePrincipal(req);
    return catalog(this.pool);
  }

  @Get("integrations/connections")
  async connections(@Req() req: Request) {
    this.admin(req);
    return listConnections(this.pool);
  }

  /** Checks a token and says whose it is and what it sees (nothing is saved). */
  @Post("integrations/check")
  @HttpCode(200)
  async check(@Req() req: Request, @Body() body: unknown) {
    this.admin(req);
    const b = parse(z.object(connect), body);
    return guard(() => checkConnection(this.hub, b));
  }

  @Post("integrations/connections")
  async create(@Req() req: Request, @Body() body: unknown) {
    const p = this.admin(req);
    const b = parse(z.object({ ...connect, repos: repos.optional() }), body);
    return guard(() => createConnection(this.hub, p, b));
  }

  @Get("integrations/connections/:id/repos")
  async repos(@Req() req: Request, @Param("id") id: string) {
    this.admin(req);
    return guard(() => connectionRepos(this.hub, id));
  }

  @Patch("integrations/connections/:id")
  async update(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    this.admin(req);
    const b = parse(z.object({ token: connect.token.optional(), repos: repos.optional(), enabled: z.boolean().optional() }), body);
    return guard(() => updateConnection(this.hub, id, b));
  }

  @Delete("integrations/connections/:id")
  @HttpCode(204)
  async remove(@Req() req: Request, @Param("id") id: string) {
    this.admin(req);
    await guard(() => removeConnection(this.pool, id));
  }

  // A task's linked work: pull and merge requests, issues, designs, as live cards.
  @Get("tasks/:ref/links")
  async links(@Req() req: Request, @Param("ref") ref: string) {
    const p = requirePrincipal(req);
    const id = await this.ref("task", ref);
    return guard(() => taskLinks(this.hub, p, id));
  }

  @Post("tasks/:ref/links")
  async add(@Req() req: Request, @Param("ref") ref: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(z.object({ url: z.string().trim().url().max(2000) }), body);
    const id = await this.ref("task", ref);
    return guard(() => addLink(this.hub, p, id, b.url));
  }

  @Post("tasks/:ref/links/:id/refresh")
  @HttpCode(200)
  async refresh(@Req() req: Request, @Param("ref") ref: string, @Param("id") linkId: string) {
    const p = requirePrincipal(req);
    const id = await this.ref("task", ref);
    return guard(() => refreshLink(this.hub, p, id, linkId));
  }

  @Get("tasks/:ref/links/:id/thumbnail")
  async thumbnail(@Req() req: Request, @Param("ref") ref: string, @Param("id") linkId: string) {
    const p = requirePrincipal(req);
    const id = await this.ref("task", ref);
    return guard(() => linkThumbnail(this.hub, p, id, linkId));
  }

  @Delete("tasks/:ref/links/:id")
  @HttpCode(204)
  async unlink(@Req() req: Request, @Param("ref") ref: string, @Param("id") linkId: string) {
    const p = requirePrincipal(req);
    const id = await this.ref("task", ref);
    await guard(() => removeLink(this.hub, p, id, linkId));
  }

  /** A project's pull and merge requests, by the tasks they are linked to. */
  @Get("projects/:ref/reviews")
  async reviews(@Req() req: Request, @Param("ref") ref: string) {
    // Each review is shown only with a task the caller may read (hub.ts projectReviews).
    const p = requirePrincipal(req);
    const id = await this.ref("project", ref);
    return guard(() => projectReviews(this.hub, p, id));
  }
}
