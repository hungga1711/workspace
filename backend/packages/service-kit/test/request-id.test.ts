import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Body, Controller, Get, MiddlewareConsumer, Post, Module, NestModule, NotFoundException, Req, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { Request } from "express";
import { currentRequestId, newId, type Principal } from "@workspace/shared";
import { ErrorFilter, principalMiddleware } from "../src/nest.js";
import { PRINCIPAL_HEADER, signInternalToken } from "../src/internal-token.js";
import { runJob } from "../src/request-id.js";

const SECRET = "test-secret-at-least-32-bytes-long!!";
const user: Principal = { type: "user", id: "u1", teamIds: [], departmentId: null, grants: [] };

@Controller()
class Probe {
  @Get("health") health() {
    return { requestId: currentRequestId() };
  }
  @Get("whoami") whoami(@Req() req: Request) {
    return { requestId: currentRequestId(), onReq: req.requestId };
  }
  @Get("boom") boom() {
    throw new NotFoundException("nothing here");
  }
  @Post("echo") echo(@Body() b: unknown) {
    return b;
  }
}

let app: INestApplication;
let base: string;

beforeAll(async () => {
  const Mw = principalMiddleware(SECRET);
  @Module({ controllers: [Probe] })
  class M implements NestModule {
    configure(c: MiddlewareConsumer) {
      c.apply(Mw).forRoutes("*");
    }
  }
  app = await NestFactory.create(M, { logger: false });
  app.useGlobalFilters(new ErrorFilter());
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "127.0.0.1");
});
afterAll(async () => {
  await app?.close();
});

const authed = async (requestId: string) => ({ [PRINCIPAL_HEADER]: await signInternalToken({ principal: user, requestId }, SECRET) });

describe("request ids on every request", () => {
  it("uses the gateway-signed request id, binds it, and echoes it", async () => {
    const id = newId();
    const res = await fetch(`${base}/whoami`, { headers: await authed(id) });
    expect(res.headers.get("x-request-id")).toBe(id);
    expect(await res.json()).toEqual({ requestId: id, onReq: id });
  });

  it("gives public routes a request id: the caller's if well-formed, else a new one", async () => {
    const given = "probe-req-0001";
    const a = await fetch(`${base}/health`, { headers: { "x-request-id": given } });
    expect(a.headers.get("x-request-id")).toBe(given);
    expect((await a.json()).requestId).toBe(given);
    const b = await fetch(`${base}/health`, { headers: { "x-request-id": "bad id with spaces" } });
    expect(b.headers.get("x-request-id")).toMatch(/^[0-9A-Z]{26}$/);
  });

  it("puts the request id in error bodies, including rejected auth", async () => {
    const id = newId();
    const res = await fetch(`${base}/boom`, { headers: await authed(id) });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ requestId: id });
    const unauth = await fetch(`${base}/whoami`);
    expect(unauth.status).toBe(401);
    const body = await unauth.json();
    expect(body.requestId).toBe(unauth.headers.get("x-request-id"));
  });

  it("answers malformed and oversized bodies with 4xx, not 500", async () => {
    const h = { ...(await authed(newId())), "content-type": "application/json" };
    const bad = await fetch(`${base}/echo`, { method: "POST", headers: h, body: "{not json" });
    expect(bad.status).toBe(400);
    const big = await fetch(`${base}/echo`, { method: "POST", headers: h, body: JSON.stringify({ x: "a".repeat(200_000) }) });
    expect(big.status).toBe(413);
    expect(await big.json()).toMatchObject({ error: "request body too large" });
  });

  it("runs background jobs under their own request id", async () => {
    let seen: string | undefined;
    await runJob("probe", async () => {
      seen = currentRequestId();
    });
    expect(seen).toMatch(/^[0-9A-Z]{26}$/);
  });
});
