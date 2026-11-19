import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import type { Principal } from "@workspace/shared";
import { clearInProcess, moduleRouter, serveInProcess, serviceFetch } from "../src/index.js";
import { PRINCIPAL_HEADER, verifyInternalToken } from "../src/internal-token.js";
import { ServiceCallError, ServiceClient } from "../src/service-client.js";

const SECRET = "in-process-test-secret-at-least-32-bytes!";

/** A module stand-in: echoes what reached it, the way a module's HTTP API would see it. */
const echo: RequestListener = (req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    if (req.url === "/empty") return void res.writeHead(204).end();
    if (req.url === "/missing") return void res.writeHead(404, { "content-type": "application/json" }).end('{"error":"nope"}');
    const token = req.headers[PRINCIPAL_HEADER] as string | undefined;
    const who = token ? (await verifyInternalToken(token, SECRET)).principal.id : null;
    res.writeHead(200, { "content-type": "application/json", "x-module": "echo" });
    res.end(JSON.stringify({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null, who }));
  });
};

const user: Principal = { type: "user", id: "lan", teamIds: [], departmentId: null, grants: [] };

afterEach(() => clearInProcess());

describe("in-process module calls (ADR 0016)", () => {
  it("a ServiceClient whose base URL this process serves calls the module without a connection, with the caller's principal", async () => {
    serveInProcess("http://nowhere.invalid:4999/employee", echo);
    const client = new ServiceClient("http://nowhere.invalid:4999/employee", SECRET, "work", []);
    // nowhere.invalid does not resolve: an answer proves no network was used.
    expect(await client.request("POST", "/people/lookup?ids=a,b", { ids: ["a", "b"] }, user)).toEqual({
      method: "POST",
      url: "/people/lookup?ids=a,b",
      body: { ids: ["a", "b"] },
      who: "lan",
    });
    expect(await client.request("GET", "/whoami")).toMatchObject({ who: "work" });
  });

  it("keeps statuses, headers and empty bodies; errors surface as ServiceCallError", async () => {
    serveInProcess("http://nowhere.invalid:4999/employee/", echo);
    const empty = await serviceFetch("http://nowhere.invalid:4999/employee/empty");
    expect(empty.status).toBe(204);
    expect(await empty.text()).toBe("");
    const ok = await serviceFetch("http://nowhere.invalid:4999/employee/x");
    expect(ok.headers.get("x-module")).toBe("echo");
    const client = new ServiceClient("http://nowhere.invalid:4999/employee", SECRET, "t", []);
    const err = await client.request("GET", "/missing").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceCallError);
    expect((err as ServiceCallError).status).toBe(404);
  });

  it("only exact base URLs match: a longer path segment or another module goes over the network", async () => {
    serveInProcess("http://nowhere.invalid:4999/work", echo);
    await expect(serviceFetch("http://nowhere.invalid:4999/workers/x")).rejects.toThrow();
    await expect(serviceFetch("http://nowhere.invalid:4999/employee/x")).rejects.toThrow();
  });

  it("moduleRouter: /<module>/… reaches the module with its own paths, /health answers, other prefixes 404", async () => {
    const server = createServer(moduleRouter([{ name: "employee", handler: echo }]));
    await new Promise<void>((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect(await (await fetch(`${base}/employee/people?x=1`)).json()).toMatchObject({ url: "/people?x=1" });
    expect(await (await fetch(`${base}/employee`)).json()).toMatchObject({ url: "/" });
    expect(await (await fetch(`${base}/health`)).json()).toEqual({ ok: true, modules: ["employee"] });
    expect((await fetch(`${base}/work/tasks`)).status).toBe(404);
    server.close();
  });

  it("Express modules in one process: in-process calls parse bodies, set statuses, and leave real requests to other apps intact", async () => {
    // A module's Express app (body parser, JSON, errors) reached in-process…
    const module = express();
    module.use(express.json());
    module.post("/items", (req, res) => void res.status(201).json({ got: req.body, path: req.path }));
    module.get("/fail", () => {
      throw new Error("boom");
    });
    serveInProcess("http://nowhere.invalid:4999/employee", module as unknown as RequestListener);
    // …while another Express app (the gateway) serves real connections in the same process.
    const edge = express();
    edge.get("/ping", async (_req, res) => {
      const r = await serviceFetch("http://nowhere.invalid:4999/employee/items", { method: "POST", headers: { "content-type": "application/json" }, body: '{"a":1}' });
      res.status(200).json({ inner: r.status, body: await r.json() });
    });
    const server = edge.listen(0);
    await new Promise((r) => server.once("listening", r));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/ping`;
      for (let i = 0; i < 3; i++) expect(await (await fetch(url)).json()).toEqual({ inner: 201, body: { got: { a: 1 }, path: "/items" } });
      // Express's own error handler answers 500 in-process too.
      expect((await serviceFetch("http://nowhere.invalid:4999/employee/fail")).status).toBe(500);
      // The real server still answers normally afterwards (the shared request prototype was not touched).
      const r = await fetch(url, { headers: { "if-none-match": "x" } });
      expect(r.status).toBe(200);
    } finally {
      server.close();
    }
  });
});
