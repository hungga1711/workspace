import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import type { INestApplication } from "@nestjs/common";
import pg from "pg";
import { migrate, signInternalToken, PRINCIPAL_HEADER, S3Storage, type ServiceClient } from "@workspace/service-kit";
import { newId, type Grant, type Principal } from "@workspace/shared";
import { createWorkApp } from "../../src/modules/work/app.js";
import { scanRepos, type Requester } from "../../src/modules/work/integrations/hub.js";
import { resetTestDatabase } from "../test-db.js";

/**
 * The integrations hub end to end (work/integrations/hub.ts): an admin connects GitHub and Figma, links on tasks
 * become cards for whoever may read the task, removed links stay removed, and pull requests that name a task's code
 * are linked by the scan. GitHub and Figma are a fake that answers from a table and records what it was asked.
 */
const SECRET = "dev-internal-secret-change-me-32bytes!";
const T = (...ps: string[]): Grant[] => ps.map((permission) => ({ permission, scope: "WORKSPACE" }));
const S = (...ps: string[]): Grant[] => ps.map((permission) => ({ permission, scope: "SELF" }));
const mk = (id: string, grants: Grant[]): Principal => ({ type: "user", id, teamIds: [], departmentId: null, grants });
const admin = mk("minh", [...T("project.read", "project.create", "task.read", "task.create", "task.edit", "workspace.configure")]);
const lan = mk("lan", [...T("project.read", "project.create", "task.create"), ...S("task.read", "task.edit")]);
const huy = mk("huy", [...T("project.read", "task.create"), ...S("task.read", "task.edit")]);

const TOKEN = "ghp_super_secret_token_1234";
let pull = { state: "open", draft: false, merged: false, updated_at: "2026-11-12T09:30:00Z" };
const asked: { url: string; auth: string }[] = [];
let down = false;
const request: Requester = async (url, init) => {
  const auth = init?.headers?.authorization ?? init?.headers?.["x-figma-token"] ?? "";
  asked.push({ url, auth });
  if (down) throw new Error("timed out after 10 s");
  const ok = (body: unknown) => ({ status: 200, text: JSON.stringify(body) });
  if (!auth.includes(url.includes("figma.com") ? "figd_token_12345" : TOKEN)) return { status: 401, text: "{}" };
  if (url === "https://api.github.com/user") return ok({ login: "octo-bot" });
  if (url.startsWith("https://api.github.com/user/repos")) return ok([{ full_name: "acme/web" }]);
  if (/\/repos\/acme\/web\/pulls\/128$/.test(url))
    return ok({
      title: "T-1 Button states",
      html_url: "https://github.com/acme/web/pull/128",
      user: { login: "lily" },
      additions: 10,
      deletions: 2,
      head: { ref: "feature/button", sha: "abc" },
      base: { ref: "main" },
      ...pull,
    });
  if (/\/pulls\/128\/reviews/.test(url)) return ok([{ user: { login: "anh" }, state: "APPROVED" }]);
  if (/\/commits\/abc\/check-runs/.test(url)) return ok({ check_runs: [{ status: "completed", conclusion: "success" }] });
  if (/\/repos\/acme\/web\/pulls\?/.test(url)) return ok(scanned);
  if (/\/repos\/acme\/web\/pulls\/(\d+)$/.test(url)) {
    const n = /(\d+)$/.exec(url)![1]!;
    const s = scanned.find((x) => x.html_url.endsWith(`/${n}`));
    return s ? ok({ ...s, user: { login: "lily" }, base: { ref: "main" }, state: "open" }) : { status: 404, text: "{}" };
  }
  if (url === "https://api.figma.com/v1/me") return ok({ email: "lily@brightline.test" });
  if (/\/v1\/files\/AbCdEfGhIjKlMnOp\?depth=1$/.test(url))
    return ok({ name: "Checkout flow", lastModified: "2026-11-12T14:05:00Z", thumbnailUrl: "https://s3-alpha.figma.com/thumb.png" });
  return { status: 404, text: "{}" };
};
let scanned: { title: string; html_url: string; updated_at: string; head: { ref: string; sha: string } }[] = [];
const images: string[] = [];
const image = async (url: string) => {
  images.push(url);
  return "data:image/png;base64,iVBORw0KGgo=";
};

let app: INestApplication;
let base: string;
let pool: pg.Pool;

async function call(p: Principal, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", [PRINCIPAL_HEADER]: await signInternalToken({ principal: p, requestId: newId() }, SECRET) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const t = await res.text();
  return { status: res.status, body: t ? JSON.parse(t) : null, raw: t };
}

beforeAll(async () => {
  await migrate("postgres://workspace_owner:owner_pw@localhost:5432/workspace_test", fileURLToPath(new URL("../../migrations/work", import.meta.url)), "work");
  await resetTestDatabase();
  pool = new pg.Pool({ connectionString: "postgres://workspace_work:app_pw@localhost:5432/workspace_test", max: 5 });
  const storage = new S3Storage({
    endpoint: "http://localhost:8333",
    region: "auto",
    bucket: "workspace-files",
    accessKeyId: "workspace_dev_key",
    secretAccessKey: "workspace_dev_secret",
  });
  const ai = { request: async () => ({}) } as unknown as ServiceClient;
  app = await createWorkApp({ pool, storage, internalSecret: SECRET, ai, hub: { request, image } });
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "127.0.0.1");
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

describe("connections", () => {
  it("only people who configure the workspace connect an integration; everyone sees what is offered", async () => {
    const cat = (await call(lan, "GET", "/integrations")).body.integrations as { id: string; connected: boolean; selfHosted: boolean }[];
    expect(cat.map((i) => i.id)).toEqual(["github", "gitlab", "figma"]);
    expect(cat.every((i) => !i.connected)).toBe(true);
    expect(cat.find((i) => i.id === "gitlab")!.selfHosted).toBe(true);
    for (const [method, path, body] of [
      ["GET", "/integrations/connections", undefined],
      ["POST", "/integrations/check", { provider: "github", token: TOKEN }],
      ["POST", "/integrations/connections", { provider: "github", token: TOKEN }],
    ] as const)
      expect((await call(lan, method, path, body)).status, path).toBe(403);
  });

  it("a token is checked before it is saved, stored encrypted and never sent back", async () => {
    const bad = await call(admin, "POST", "/integrations/check", { provider: "github", token: "ghp_wrong_token_000" });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/GitHub refused the token/);
    expect((await call(admin, "POST", "/integrations/connections", { provider: "github", token: "ghp_wrong_token_000" })).status).toBe(400);

    expect((await call(admin, "POST", "/integrations/check", { provider: "github", token: TOKEN })).body).toEqual({
      account: "octo-bot",
      site: "https://github.com",
      repos: [{ id: "acme/web", name: "acme/web" }],
    });
    const made = await call(admin, "POST", "/integrations/connections", { provider: "github", token: TOKEN });
    expect(made.status).toBe(201);
    expect((await call(admin, "POST", "/integrations/connections", { provider: "github", token: TOKEN })).status).toBe(400);
    const list = await call(admin, "GET", "/integrations/connections");
    expect(list.body.connections).toMatchObject([{ id: made.body.id, provider: "github", site: "https://github.com", account: "octo-bot", enabled: true, selfHosted: false }]);
    expect(list.raw).not.toContain(TOKEN);
    const stored = (await pool.query<{ secret_enc: string }>("SELECT secret_enc FROM integration_connections")).rows[0]!.secret_enc;
    expect(stored).toMatch(/^v1:/);
    expect(stored).not.toContain(TOKEN);
    const seen = await call(lan, "GET", "/integrations");
    expect(seen.body.integrations?.find((i: { id: string }) => i.id === "github").connected, seen.raw).toBe(true);
  });

  it("only GitLab takes a site of the company's own, and an address inside the network needs saying so", async () => {
    expect((await call(admin, "POST", "/integrations/check", { provider: "github", token: TOKEN, site: "https://git.acme.example" })).body.message).toMatch(/one address/);
    const inside = await call(admin, "POST", "/integrations/check", { provider: "gitlab", token: "glpat_token_12345", site: "https://127.0.0.1" });
    expect(inside.status).toBe(400);
    expect(inside.body.message).toMatch(/inside your network/);
    expect((await call(admin, "POST", "/integrations/check", { provider: "nope", token: TOKEN })).status).toBe(404);
  });
});

describe("a task's linked work", () => {
  let task: { id: string; code: string };
  it("an address in the description becomes a card; whoever may read the task reads it, nobody else", async () => {
    task = (
      await call(lan, "POST", "/tasks", { title: "Button states", description: "PR: https://github.com/acme/web/pull/128 and notes at https://example.com/x", assigneeId: "lan" })
    ).body;
    const r = await call(lan, "GET", `/tasks/${task.id}/links`);
    expect(r.status).toBe(200);
    expect(r.body.links).toHaveLength(1);
    expect(r.body.links[0]).toMatchObject({
      provider: "github",
      providerName: "GitHub",
      kind: "review",
      source: "found",
      connected: true,
      error: null,
      card: {
        title: "T-1 Button states",
        ref: "acme/web#128",
        state: "open",
        branch: "feature/button",
        target: "main",
        checks: "passing",
        reviewers: [{ name: "anh", state: "approved" }],
      },
    });
    // By its code too, and never for someone who cannot open the task.
    expect((await call(lan, "GET", `/tasks/${task.code}/links`)).body.links).toHaveLength(1);
    expect((await call(huy, "GET", `/tasks/${task.id}/links`)).status).toBeGreaterThanOrEqual(403);
    expect((await call(huy, "POST", `/tasks/${task.id}/links`, { url: "https://github.com/acme/web/pull/128" })).status).toBeGreaterThanOrEqual(403);
  });

  it("a fresh card is not read again; an old one is, and shows the new state", async () => {
    const before = asked.length;
    await call(lan, "GET", `/tasks/${task.id}/links`);
    expect(asked.length).toBe(before);
    pull = { state: "closed", draft: false, merged: true, updated_at: "2026-11-13T10:00:00Z" };
    await pool.query("UPDATE task_work_links SET card_at = now() - interval '6 minutes'");
    expect((await call(lan, "GET", `/tasks/${task.id}/links`)).body.links[0].card).toMatchObject({ state: "merged" });
    expect(asked.length).toBeGreaterThan(before);
    expect(asked.slice(before).every((a) => a.url.startsWith("https://api.github.com/") && a.auth === `Bearer ${TOKEN}`)).toBe(true);
  });

  it("when the service cannot be reached the card keeps what it last showed and says so", async () => {
    down = true;
    await pool.query("UPDATE task_work_links SET card_at = now() - interval '6 minutes'");
    const l = (await call(lan, "GET", `/tasks/${task.id}/links`)).body.links[0];
    down = false;
    expect(l.card).toMatchObject({ state: "merged" });
    expect(l.error).toMatch(/could not reach github\.com/);
    const again = await call(lan, "POST", `/tasks/${task.id}/links/${l.id}/refresh`);
    expect(again.body).toMatchObject({ error: null, card: { state: "merged" } });
  });

  it("links are added by hand, only for addresses an integration knows; a design waits for its connection", async () => {
    expect((await call(lan, "POST", `/tasks/${task.id}/links`, { url: "https://example.com/whatever" })).body.message).toMatch(/no integration knows this address/);
    const design = await call(lan, "POST", `/tasks/${task.id}/links`, { url: "https://www.figma.com/design/AbCdEfGhIjKlMnOp/Checkout-flow" });
    expect(design.status).toBe(201);
    expect(design.body).toMatchObject({ provider: "figma", kind: "design", source: "manual", connected: false, card: null });
    // Figma connected: the card is read, its preview fetched by the server and served apart from the list.
    expect((await call(admin, "POST", "/integrations/connections", { provider: "figma", token: "figd_token_12345" })).status).toBe(201);
    const card = (await call(lan, "POST", `/tasks/${task.id}/links/${design.body.id}/refresh`)).body;
    expect(card).toMatchObject({
      connected: true,
      hasThumbnail: true,
      card: { kind: "design", title: "Checkout flow", embedUrl: expect.stringMatching(/^https:\/\/www\.figma\.com\/embed\?/) },
    });
    expect(card.card.thumbnailUrl).toBeUndefined();
    expect(images).toEqual(["https://s3-alpha.figma.com/thumb.png"]);
    expect((await call(lan, "GET", `/tasks/${task.id}/links/${design.body.id}/thumbnail`)).body.dataUrl).toMatch(/^data:image\/png;base64,/);
    expect((await call(huy, "GET", `/tasks/${task.id}/links/${design.body.id}/thumbnail`)).status).toBeGreaterThanOrEqual(403);
    // The same address again is the same link.
    await call(lan, "POST", `/tasks/${task.id}/links`, { url: "https://www.figma.com/file/AbCdEfGhIjKlMnOp/renamed" });
    expect((await call(lan, "GET", `/tasks/${task.id}/links`)).body.links).toHaveLength(2);
  });

  it("a link someone removed stays removed, though its address is still in the description", async () => {
    const links = (await call(lan, "GET", `/tasks/${task.id}/links`)).body.links as { id: string; provider: string }[];
    expect((await call(lan, "DELETE", `/tasks/${task.id}/links/${links.find((l) => l.provider === "github")!.id}`)).status).toBe(204);
    expect((await call(lan, "DELETE", `/tasks/${task.id}/links/${links.find((l) => l.provider === "figma")!.id}`)).status).toBe(204);
    expect((await call(lan, "GET", `/tasks/${task.id}/links`)).body.links).toHaveLength(0);
    // Added again by hand, it is back.
    expect((await call(lan, "POST", `/tasks/${task.id}/links`, { url: "https://github.com/acme/web/pull/128" })).body).toMatchObject({
      source: "manual",
      card: { state: "merged" },
    });
  });

  it("an address in a comment counts too", async () => {
    const other = (await call(lan, "POST", "/tasks", { title: "Another", assigneeId: "lan" })).body;
    await call(lan, "POST", `/tasks/${other.id}/comments`, { body: "see https://github.com/acme/web/pull/128." });
    expect((await call(lan, "GET", `/tasks/${other.id}/links`)).body.links).toMatchObject([{ provider: "github", source: "found" }]);
  });
});

describe("pull requests that name a task", () => {
  it("are linked to it from the repositories the admin picked, once", async () => {
    const project = (await call(admin, "POST", "/projects", { name: "Portal" })).body;
    const t = (await call(admin, "POST", "/tasks", { title: "Totals", projectId: project.id })).body as { id: string; code: string };
    const conn = (await call(admin, "GET", "/integrations/connections")).body.connections.find((c: { provider: string }) => c.provider === "github");
    scanned = [
      { title: `${t.code} checkout totals`, html_url: "https://github.com/acme/web/pull/201", updated_at: "2026-11-13T08:00:00Z", head: { ref: "fix/totals", sha: "d1" } },
      {
        title: "No code here",
        html_url: "https://github.com/acme/web/pull/202",
        updated_at: "2026-11-13T08:00:00Z",
        head: { ref: `feature/${t.code.toLowerCase()}-rounding`, sha: "d2" },
      },
      { title: "Unrelated ZZZ-999", html_url: "https://github.com/acme/web/pull/203", updated_at: "2026-11-13T08:00:00Z", head: { ref: "chore/deps", sha: "d3" } },
    ];
    // Nothing is looked through until repositories are picked.
    const deps = { pool, request, image };
    expect(await scanRepos(deps)).toEqual({ linked: 0 });
    expect((await call(admin, "PATCH", `/integrations/connections/${conn.id}`, { repos: ["acme/web"] })).status).toBe(200);
    expect(await scanRepos(deps)).toEqual({ linked: 2 });
    expect(await scanRepos(deps)).toEqual({ linked: 0 });
    const links = (await call(admin, "GET", `/tasks/${t.id}/links`)).body.links as { source: string; card: { ref: string } }[];
    expect(links.map((l) => [l.source, l.card.ref]).sort()).toEqual([
      ["scan", "acme/web#201"],
      ["scan", "acme/web#202"],
    ]);
    // The project's reviews: each with its task, for people who may open that task.
    const reviews = (await call(admin, "GET", `/projects/${project.id}/reviews`)).body.reviews as { task: { code: string }; card: { ref: string } }[];
    expect(reviews).toHaveLength(2);
    expect(reviews[0]!.task.code).toBe(t.code);
    const none = await call(huy, "GET", `/projects/${project.id}/reviews`);
    expect(none.body.reviews, none.raw).toEqual([]);
  });

  it("a refused token is the connection's problem, shown to the admin; disconnecting leaves the links as they were", async () => {
    const conn = (await call(admin, "GET", "/integrations/connections")).body.connections.find((c: { provider: string }) => c.provider === "github");
    expect((await call(admin, "PATCH", `/integrations/connections/${conn.id}`, { token: "ghp_wrong_token_000" })).status).toBe(400);
    await pool.query("UPDATE integration_connections SET secret_enc = (SELECT secret_enc FROM integration_connections WHERE provider = 'figma') WHERE id = $1", [conn.id]);
    await pool.query("UPDATE task_work_links SET card_at = now() - interval '6 minutes' WHERE provider = 'github'");
    const t = (await pool.query<{ task_id: string }>("SELECT task_id FROM task_work_links WHERE provider = 'github' AND source = 'scan' LIMIT 1")).rows[0]!;
    const l = (await call(admin, "GET", `/tasks/${t.task_id}/links`)).body.links[0];
    expect(l.error).toMatch(/refused the token/);
    expect((await call(admin, "GET", "/integrations/connections")).body.connections.find((c: { id: string }) => c.id === conn.id).lastError).toMatch(/refused the token/);
    expect((await call(admin, "DELETE", `/integrations/connections/${conn.id}`)).status).toBe(204);
    const after = (await call(admin, "GET", `/tasks/${t.task_id}/links`)).body.links[0];
    expect(after).toMatchObject({ connected: false, card: { kind: "review" } });
  });
});
