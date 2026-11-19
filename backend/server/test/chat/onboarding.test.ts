import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { migrate, signInternalToken, PRINCIPAL_HEADER } from "@workspace/service-kit";
import { newId, runWithContext, withTransaction, type Principal } from "@workspace/shared";
import type { EventEnvelope } from "@workspace/contracts";
import { createChatApp, depsFromEnv } from "../../src/modules/chat/app.js";
import { handleOnboardingEvent } from "../../src/modules/chat/onboarding.js";
import { resetTestDatabase } from "../test-db.js";

const SECRET = "dev-internal-secret-change-me-32bytes!";
const RUN = newId().slice(-6);
const EMP = ["channel.create", "channel.read", "message.post", "message.read"].map((permission) => ({ permission, scope: "WORKSPACE" as const }));
const owner: Principal = { type: "user", id: `owner-${RUN}`, teamIds: [], departmentId: null, grants: EMP };
const lan: Principal = { ...owner, id: `lan-${RUN}` };
const deps = depsFromEnv();
let app: { close: () => Promise<void> };
let base: string;

const event = (eventType: string, payload: Record<string, unknown>): EventEnvelope => ({
  eventId: newId(),
  eventType,
  version: 1,
  aggregateType: "x",
  aggregateId: "workspace",
  actorId: "test",
  occurredAt: new Date().toISOString(),
  payload,
});
const deliver = (e: EventEnvelope) => runWithContext({ actorId: "test", requestId: newId() }, () => withTransaction(deps.pool, (c) => handleOnboardingEvent(e, c)));

async function call(p: Principal, path: string) {
  const res = await fetch(`${base}${path}`, { headers: { [PRINCIPAL_HEADER]: await signInternalToken({ principal: p, requestId: newId() }, SECRET) } });
  return { status: res.status, body: await res.json() };
}

beforeAll(async () => {
  await resetTestDatabase();
  await migrate("postgres://workspace_owner:owner_pw@localhost:5432/workspace_test", fileURLToPath(new URL("../../migrations/chat", import.meta.url)), "chat");
  const created = await createChatApp(deps);
  app = created.app;
  base = `http://127.0.0.1:${await created.listen(0)}`;
});
afterAll(async () => {
  await app?.close();
});

describe("onboarding", () => {
  const created = event("platform.workspace.created.v1", { name: "Lâm An", ownerUserId: owner.id, ownerName: "Minh", teamType: "sales", locale: "vi" });

  it("provisions #general with a system welcome thread and the team's starter channels", async () => {
    await deliver(created);
    const { channels } = (await call(owner, "/channels")).body as { channels: { id: string; name: string }[] };
    expect(channels.map((c) => c.name).sort()).toEqual(["bao-gia", "co-hoi", "general", "khach-hang"]);
    const general = channels.find((c) => c.name === "general")!;
    const { messages } = (await call(owner, `/channels/${general.id}/messages?limit=10`)).body;
    expect(messages).toHaveLength(1);
    expect(messages[0].authorType).toBe("system");
    expect(messages[0].replyCount).toBe(3);
    expect(messages[0].body).toContain("Lâm An");
  });

  it("is idempotent when the event is processed again", async () => {
    await deliver({ ...created, eventId: newId() });
    const { channels } = (await call(owner, "/channels")).body as { channels: { name: string }[] };
    expect(channels.filter((c) => c.name === "general")).toHaveLength(1);
  });

  it("adds a newly joined member to #general and the starter channels, already caught up", async () => {
    await deliver(event("identity.member.joined.v1", { userId: lan.id }));
    const { channels } = (await call(lan, "/channels")).body as { channels: { id: string; name: string; unread: number }[] };
    expect(channels.map((c) => c.name).sort()).toEqual(["bao-gia", "co-hoi", "general", "khach-hang"]);
    expect(channels.every((c) => c.unread === 0)).toBe(true);
    // Only workspace admins may change who joins automatically; a member sees the setting but cannot.
    const starter = (await call(lan, `/channels/${channels.find((c) => c.name === "bao-gia")!.id}`)).body;
    expect(starter).toMatchObject({ autoJoin: true, canSetAutoJoin: false });
  });

  it("invited people can be added to channels before they sign in; disabled people cannot", async () => {
    const known = async () =>
      runWithContext({ actorId: "test", requestId: newId() }, () =>
        withTransaction(deps.pool, async (c) => (await c.query<{ user_id: string }>("SELECT user_id FROM known_members WHERE user_id = 'newbie'")).rowCount),
      );
    await deliver(event("identity.member.invited.v1", { userId: "newbie" }));
    expect(await known()).toBe(1);
    await deliver(event("identity.member.disabled.v1", { userId: "newbie" }));
    expect(await known()).toBe(0);
    await deliver(event("identity.member.enabled.v1", { userId: "newbie" }));
    expect(await known()).toBe(1);
  });

  it("ignores a workspace created without an owner id (pre-onboarding events)", async () => {
    await expect(deliver(event("platform.workspace.created.v1", { name: "Old" }))).resolves.toBeUndefined();
  });

  it("a member who joins before the workspace is provisioned still lands in #general (unordered topics)", async () => {
    // A fresh installation: the events arrive in the wrong order.
    await resetTestDatabase();
    await deliver(event("identity.member.joined.v1", { userId: "early-bird" }));
    await deliver(event("platform.workspace.created.v1", { name: "Sớm", ownerUserId: "boss", ownerName: "Sếp", teamType: "product", locale: "vi" }));
    const early = { ...lan, id: "early-bird" };
    const { channels } = (await call(early, "/channels")).body as { channels: { name: string }[] };
    expect(channels.map((c) => c.name)).toEqual(["general"]);
  });
});
