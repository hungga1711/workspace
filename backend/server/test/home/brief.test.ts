import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import type { INestApplication } from "@nestjs/common";
import pg from "pg";
import { migrate, PRINCIPAL_HEADER, signInternalToken, type ServiceClient } from "@workspace/service-kit";
import { newId, withTransaction, type Principal } from "@workspace/shared";
import { createHomeApp } from "../../src/modules/home/app.js";

/** The AI brief's context: what the person has today, in their zone or (none chosen) the workspace's. */
const SECRET = "dev-internal-secret-change-me-32bytes!";
// Its own user id: other suites leave Home rows for "minh" in the shared test database.
const MINH = `minh-${newId()}`;
const minh: Principal = { type: "user", id: MINH, teamIds: [], departmentId: null, grants: [{ permission: "home.read", scope: "SELF" }] };
let app: INestApplication;
let url: string;
let pool: pg.Pool;
const sent: { today: { title: string }[] }[] = [];
const ai = {
  request: async (_method: string, _path: string, body: { today: { title: string }[] }) => {
    sent.push(body);
    return { recommendation: "ok", digest: [] };
  },
} as unknown as ServiceClient;

beforeAll(async () => {
  await migrate("postgres://workspace_owner:owner_pw@localhost:5432/workspace_test", fileURLToPath(new URL("../../migrations/home", import.meta.url)), "home");
  pool = new pg.Pool({ connectionString: "postgres://workspace_home:app_pw@localhost:5432/workspace_test", max: 2 });
  app = await createHomeApp({ pool, ai, internalSecret: SECRET });
  await app.listen(0);
  url = (await app.getUrl()).replace("[::1]", "127.0.0.1");
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

describe("home brief", () => {
  it("sends today's items when the person follows the workspace's time zone", async () => {
    await withTransaction(pool, async (c) => {
      await c.query("INSERT INTO user_prefs (user_id, timezone) VALUES ($1, NULL)", [MINH]);
      await c.query("INSERT INTO home_items (user_id, kind, ref_id, title, url, starts_at, needs_action) VALUES ($1, 'meeting', $2, 'Giao ban', '/app/home', now(), false)", [
        MINH,
        newId(),
      ]);
    });
    const res = await fetch(`${url}/home/brief`, { method: "POST", headers: { [PRINCIPAL_HEADER]: await signInternalToken({ principal: minh, requestId: newId() }, SECRET) } });
    expect((await res.json()).status).toBe("ready");
    expect(sent.at(-1)!.today.map((i) => i.title)).toEqual(["Giao ban"]);
  });
});
