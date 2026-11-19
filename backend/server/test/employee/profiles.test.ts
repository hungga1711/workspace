import { beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { migrate } from "@workspace/service-kit";
import { newId, runWithContext, withTransaction } from "@workspace/shared";
import type { EventEnvelope } from "@workspace/contracts";
import { ensureProfile } from "../../src/modules/employee/profiles.js";
import { resetTestDatabase } from "../test-db.js";

const pool = new pg.Pool({ connectionString: "postgres://workspace_employee:app_pw@localhost:5432/workspace_test", max: 2 });
const ev = (eventType: string, payload: Record<string, unknown>): EventEnvelope => ({
  eventId: newId(),
  eventType,
  version: 1,
  aggregateType: "identity.member",
  aggregateId: newId(),
  actorId: "test",
  occurredAt: new Date().toISOString(),
  requestId: newId(),
  payload,
});
const deliver = (e: EventEnvelope) => runWithContext({ actorId: "test", requestId: e.requestId! }, () => withTransaction(pool, (c) => ensureProfile(e, c)));
const profile = (userId: string) =>
  runWithContext({ actorId: "test", requestId: newId() }, () =>
    withTransaction(pool, async (c) => (await c.query("SELECT code, display_name FROM employees WHERE user_id = $1", [userId])).rows[0]),
  );

beforeAll(async () => {
  await resetTestDatabase();
  await migrate("postgres://workspace_owner:owner_pw@localhost:5432/workspace_test", fileURLToPath(new URL("../../migrations/employee", import.meta.url)), "employee");
});

describe("member → employee profile (onboarding)", () => {
  it("creates a basic profile with a sequential EMP code when a member is invited or joins", async () => {
    await deliver(ev("identity.member.joined.v1", { userId: "owner-1", displayName: "Trần Minh", owner: true }));
    await deliver(ev("identity.member.invited.v1", { userId: "lan-1", displayName: "Nguyễn Thị Lan", email: "lan@x.vn" }));
    expect(await profile("owner-1")).toEqual({ code: "EMP-000001", display_name: "Trần Minh" });
    expect(await profile("lan-1")).toEqual({ code: "EMP-000002", display_name: "Nguyễn Thị Lan" });
  });

  it("never overwrites a profile an admin already edited", async () => {
    await runWithContext({ actorId: "test", requestId: newId() }, () =>
      withTransaction(pool, (c) => c.query("UPDATE employees SET display_name = 'Minh (CEO)' WHERE user_id = 'owner-1'")),
    );
    await deliver(ev("identity.member.joined.v1", { userId: "owner-1", displayName: "Trần Minh" }));
    expect((await profile("owner-1")).display_name).toBe("Minh (CEO)");
  });

  it("follows a rename (Của tôi › Hồ sơ or the company's IdP)", async () => {
    await deliver(ev("identity.member.renamed.v1", { userId: "lan-1", email: "lan@x.vn", displayName: "Nguyễn Thị Lan Anh" }));
    expect((await profile("lan-1")).display_name).toBe("Nguyễn Thị Lan Anh");
  });

  it("falls back to the email name when the event has no display name", async () => {
    await deliver(ev("identity.member.invited.v1", { userId: "x-1", email: "huy.pham@x.vn" }));
    expect((await profile("x-1")).display_name).toBe("huy.pham");
  });
});
