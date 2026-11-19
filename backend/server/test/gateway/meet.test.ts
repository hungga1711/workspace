import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import express from "express";
import { ServiceClient, verifyInternalToken, PRINCIPAL_HEADER } from "@workspace/service-kit";
import { createGateway } from "../../src/modules/gateway/gateway.js";

const SECRET = "dev-internal-secret-change-me-32bytes!";
let gwServer: Server;
let workServer: Server;
let gw: string;
const seen: { method: string; path: string; body: unknown; caller: string }[] = [];

beforeAll(async () => {
  // Stand-in work module: records what the gateway forwards and who it says it is.
  const work = express();
  work.use(express.json());
  work.all("*", async (req, res) => {
    const { principal } = await verifyInternalToken(req.header(PRINCIPAL_HEADER) ?? "", SECRET);
    seen.push({ method: req.method, path: req.path, body: req.body, caller: `${principal.type}:${principal.id}` });
    if (req.path.includes("zzz-zzzz-zzz")) return res.status(404).json({ error: "meeting not found" });
    res.json({ ok: true, path: req.path });
  });
  workServer = work.listen(0);
  const workUrl = `http://127.0.0.1:${(workServer.address() as { port: number }).port}`;

  const unused = new ServiceClient("http://127.0.0.1:1", SECRET, "gateway", []);
  gwServer = createGateway({
    jwksUrl: "http://127.0.0.1:1/internal/auth/jwks",
    internalSecret: SECRET,
    identity: unused,
    platform: unused,
    work: new ServiceClient(workUrl, SECRET, "gateway", [{ permission: "principal.resolve", scope: "PLATFORM" }]),
    services: {},
    rateLimit: { userPerMinute: 1000, signupPerIpPerHour: 4 },
  }).listen(0);
  gw = `http://127.0.0.1:${(gwServer.address() as { port: number }).port}`;
});

afterAll(async () => {
  gwServer?.close();
  workServer?.close();
});

describe("public meeting links", () => {
  it("forward a guest's preview, join and status to the work module as the gateway, with no login", async () => {
    expect((await fetch(`${gw}/api/meet/abc-defg-hij`)).status).toBe(200);
    const join = await fetch(`${gw}/api/meet/abc-defg-hij/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Lan" }) });
    expect(join.status).toBe(200);
    await fetch(`${gw}/api/meet/abc-defg-hij/status`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: "r", secret: "s" }) });
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([
      "GET /internal/meet/abc-defg-hij",
      "POST /internal/meet/abc-defg-hij/join",
      "POST /internal/meet/abc-defg-hij/status",
    ]);
    expect(seen.every((s) => s.caller === "service:gateway")).toBe(true);
    expect(seen[1]!.body).toEqual({ name: "Lan" });
  });

  it("refuse malformed codes without asking the work module, and pass through its 404", async () => {
    const before = seen.length;
    expect((await fetch(`${gw}/api/meet/..%2Finternal`)).status).toBe(404);
    expect((await fetch(`${gw}/api/meet/ABC-DEFG-HIJ`)).status).toBe(404);
    expect(seen.length).toBe(before);
    expect((await fetch(`${gw}/api/meet/zzz-zzzz-zzz`)).status).toBe(404);
  });

  it("limit join attempts per IP", async () => {
    const ask = () => fetch(`${gw}/api/meet/abc-defg-hij/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "x" }) });
    const codes: number[] = [];
    for (let i = 0; i < 21; i++) codes.push((await ask()).status);
    expect(codes.at(-1)).toBe(429);
  });
});
