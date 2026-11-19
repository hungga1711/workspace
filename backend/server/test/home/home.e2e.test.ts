import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import type { INestApplication } from "@nestjs/common";
import pg from "pg";
import { EventBus, migrate, signInternalToken, PRINCIPAL_HEADER, startConsumer, startOutboxRelay, S3Storage, type EventConsumer, type OutboxRelay } from "@workspace/service-kit";
import { newId, runWithContext, withTransaction, type Grant, type Principal } from "@workspace/shared";
import type { EventEnvelope } from "@workspace/contracts";
import { createHomeApp } from "../../src/modules/home/app.js";
import { HOME_TOPICS, project } from "../../src/modules/home/projector.js";
import { sendInstantPushes, sendMorningPushes } from "../../src/modules/home/push.js";
import { sendDueReminders, sendPersonalReminders } from "../../src/modules/home/reminders.js";
import { createWorkApp } from "../../src/modules/work/app.js";
import { createChatApp, depsFromEnv as chatDeps } from "../../src/modules/chat/app.js";

const SECRET = "dev-internal-secret-change-me-32bytes!";
// Tags this run's rows (push endpoints, channel names, emails) in a database other runs may share.
const RUN = newId();
const T = (...ps: string[]): Grant[] => ps.map((permission) => ({ permission, scope: "WORKSPACE" }));
const S = (...ps: string[]): Grant[] => ps.map((permission) => ({ permission, scope: "SELF" }));
const GRANTS = [
  ...T("project.read", "project.create", "task.read", "task.create", "document.read", "document.create", "channel.create", "channel.read", "message.post", "message.read"),
  ...S("task.edit", "task.assign", "home.read", "calendar.edit", "calendar.read", "document.edit", "document.share"),
];
const u = (id: string): Principal => ({ type: "user", id, teamIds: [], departmentId: null, grants: GRANTS });
const minh = u("minh");
const lan = u("lan");

let home: INestApplication;
let work: INestApplication;
let chatClose: () => Promise<void>;
const urls: Record<string, string> = {};
let consumer: EventConsumer;
const bus = new EventBus();
const relays: OutboxRelay[] = [];
let homePool: pg.Pool;

async function call(svc: string, p: Principal, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
  const res = await fetch(`${urls[svc]}${path}`, {
    method,
    headers: { "content-type": "application/json", [PRINCIPAL_HEADER]: await signInternalToken({ principal: p, requestId: newId() }, SECRET), ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const t = await res.text();
  return { status: res.status, body: t ? JSON.parse(t) : null };
}

const eventually = async (fn: () => Promise<boolean>, ms = 60_000) => {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error("timed out waiting for projection");
    await new Promise((r) => setTimeout(r, 300));
  }
};
const needsYou = async (p: Principal) => (await call("home", p, "GET", "/home")).body.needsYou as { kind: string; refId: string; title: string }[];

beforeAll(async () => {
  for (const [db, dir] of [
    ["home", "../../migrations/home"],
    ["work", "../../migrations/work"],
    ["chat", "../../migrations/chat"],
  ] as const) {
    await migrate("postgres://workspace_owner:owner_pw@localhost:5432/workspace_test", fileURLToPath(new URL(dir, import.meta.url)), db);
  }
  // Chat only adds workspace members to conversations; register the test users as known members.
  const chatDb = new pg.Client("postgres://workspace_owner:owner_pw@localhost:5432/workspace_test?options=-c%20search_path%3Dchat");
  await chatDb.connect();
  for (const id of ["minh", "lan"]) await chatDb.query("INSERT INTO known_members (user_id) VALUES ($1) ON CONFLICT DO NOTHING", [id]);
  await chatDb.end();
  homePool = new pg.Pool({ connectionString: "postgres://workspace_home:app_pw@localhost:5432/workspace_test", max: 10 });
  // A workspace set up in Vietnamese: people who never picked a language get its texts (the default is English).
  await homePool.query("INSERT INTO workspace_settings (timezone, version, locale) VALUES ('Asia/Ho_Chi_Minh', 0, 'vi') ON CONFLICT (singleton) DO UPDATE SET locale = 'vi'");
  home = await createHomeApp({ pool: homePool, ai: null, internalSecret: SECRET });
  await home.listen(0);
  urls.home = (await home.getUrl()).replace("[::1]", "127.0.0.1");
  const workPool = new pg.Pool({ connectionString: "postgres://workspace_work:app_pw@localhost:5432/workspace_test", max: 10 });
  work = await createWorkApp({
    pool: workPool,
    storage: new S3Storage({
      endpoint: "http://localhost:8333",
      region: "auto",
      bucket: "workspace-files",
      accessKeyId: "workspace_dev_key",
      secretAccessKey: "workspace_dev_secret",
    }),
    internalSecret: SECRET,
  });
  await work.listen(0);
  urls.work = (await work.getUrl()).replace("[::1]", "127.0.0.1");
  const cd = chatDeps();
  const chat = await createChatApp(cd);
  urls.chat = `http://127.0.0.1:${await chat.listen(0)}`;
  chatClose = () => chat.app.close();
  // Work's and chat's events reach home through their outboxes: relay them here. A running test server relays the
  // same outboxes; whichever relay claims a row, its home projector writes the same Home tables this test reads.
  relays.push(startOutboxRelay({ pool: workPool, bus }), startOutboxRelay({ pool: cd.pool, bus }));
  consumer = await startConsumer({ bus, groupId: "home-test", topics: HOME_TOPICS, pool: homePool, handle: project });
  bus.start();
});

afterAll(async () => {
  await consumer?.stop();
  await Promise.all(relays.map((r) => r.stop()));
  await home?.close();
  await work?.close();
  await chatClose?.();
});

/** Well-formed subscription keys (65-byte P-256 point, 16-byte auth secret); the fake sender never encrypts. */
const PUSH_KEYS = { p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString("base64url"), auth: Buffer.alloc(16, 9).toString("base64url") };

describe("Home read model (event-driven)", () => {
  it("shows a task assigned to Lan, then removes it when completed", async () => {
    const t = (await call("work", minh, "POST", "/tasks", { title: "Review proposal", assigneeId: "lan", priority: "high", dueAt: new Date(Date.now() + 3600_000).toISOString() }))
      .body;
    expect(t.assigneeId).toBe("lan");
    await eventually(async () => (await needsYou(lan)).some((i) => i.refId === t.id));
    const h = (await call("home", lan, "GET", "/home")).body;
    expect(h.counts.tasks).toBeGreaterThanOrEqual(1);
    const inbox = (await call("home", lan, "GET", "/notifications")).body;
    expect(inbox.action.some((n: { kind: string }) => n.kind === "task.assigned")).toBe(true);
    await call("work", lan, "PATCH", `/tasks/${t.id}`, { expectedVersion: t.version, status: "done" });
    await eventually(async () => !(await needsYou(lan)).some((i) => i.refId === t.id));
    await eventually(async () => (await call("home", minh, "GET", "/notifications")).body.updates.some((n: { kind: string }) => n.kind === "task.completed"));
  });

  it("surfaces mentions and unanswered DMs; replying resolves the DM", async () => {
    const ch = (await call("chat", minh, "POST", "/channels", { kind: "public", name: `home-${RUN.slice(-6)}`, memberIds: ["lan"] })).body.id;
    const m = (await call("chat", minh, "POST", `/channels/${ch}/messages`, { body: "<@lan> can you approve the budget?" })).body;
    const dm = (await call("chat", minh, "POST", "/dms", { userId: "lan" })).body.id;
    await call("chat", minh, "POST", `/channels/${dm}/messages`, { body: "Lan, are you free?" });
    await eventually(async () => {
      const n = await needsYou(lan);
      return n.some((i) => i.kind === "mention" && i.refId === m.id) && n.some((i) => i.kind === "dm" && i.refId === dm);
    });
    await call("chat", lan, "POST", `/channels/${dm}/messages`, { body: "Yes" });
    await eventually(async () => !(await needsYou(lan)).some((i) => i.kind === "dm" && i.refId === dm));
    // Minh is now the one waiting.
    await eventually(async () => (await needsYou(minh)).some((i) => i.kind === "dm" && i.refId === dm));
  });

  it("puts approvals first in Needs You", async () => {
    const a = (await call("work", minh, "POST", "/approvals", { title: "Chi phí marketing", approverId: "lan" })).body;
    await eventually(async () => (await needsYou(lan))[0]?.refId === a.id);
  });

  it("lists today's meetings in Today", async () => {
    // Soon, so it is still today whatever time the suite runs (now + 2 h crossed midnight after 22:00).
    const start = new Date(Date.now() + 60_000);
    await call("work", minh, "POST", "/calendar/events", {
      title: "Sync Alpha",
      startsAt: start.toISOString(),
      endsAt: new Date(start.getTime() + 1800_000).toISOString(),
      attendeeIds: ["lan"],
    });
    await eventually(async () => (await call("home", lan, "GET", "/home")).body.today.some((i: { title: string }) => i.title === "Sync Alpha"));
  });

  it("ignores out-of-order task events", async () => {
    const taskId = newId();
    const ev = (version: number, status: string): EventEnvelope => ({
      eventId: newId(),
      eventType: "work.task.updated.v1",
      version: 1,
      aggregateType: "work.task",
      aggregateId: taskId,
      actorId: "user:minh",
      occurredAt: new Date().toISOString(),
      payload: { taskId, title: "ooo", code: "T-1", assigneeId: "lan", status, version, dueAt: null, priority: "low" },
    });
    await runWithContext({ actorId: "test", requestId: newId() }, () =>
      withTransaction(homePool, async (c) => {
        await project(ev(3, "done"), c);
        await project(ev(2, "in_progress"), c); // late, older
      }),
    );
    expect((await needsYou(lan)).some((i) => i.refId === taskId)).toBe(false);
  });

  it("morning push sends counts only and deletes dead subscriptions (E4b, E6)", async () => {
    await call("home", lan, "POST", "/push/subscriptions", { endpoint: `https://push.example.com/dead-${RUN}`, keys: PUSH_KEYS });
    await call("home", lan, "POST", "/push/subscriptions", { endpoint: `https://push.example.com/live-${RUN}`, keys: PUSH_KEYS });
    await call("home", lan, "PUT", "/prefs", { timezone: "Pacific/Kiritimati" }); // UTC+14: always past 08:00 for this test's purposes most of the day
    await runWithContext({ actorId: "test", requestId: newId() }, () =>
      withTransaction(homePool, (c) => c.query("UPDATE user_prefs SET timezone = 'UTC', last_push_date = NULL WHERE user_id = 'lan'")),
    );
    const sent: { endpoint: string; payload: string }[] = [];
    const hour = new Date().getUTCHours();
    await sendMorningPushes(homePool, {
      send: async (s, payload) => {
        sent.push({ endpoint: s.endpoint, payload });
        return { statusCode: s.endpoint.includes("dead") ? 410 : 201 };
      },
    });
    const ours = sent.filter((s) => s.endpoint.endsWith(RUN));
    if (hour < 8) {
      expect(ours).toHaveLength(0); // before 08:00 local nothing is sent
      return;
    }
    const live = ours.find((s) => s.endpoint.includes("live"))!;
    expect(JSON.parse(live.payload).body).toMatch(/^\d+ việc · \d+ cuộc họp · \d+ phê duyệt$/);
    expect(ours.filter((s) => s.endpoint.includes("dead"))).toHaveLength(1);
    const again: string[] = [];
    await sendMorningPushes(homePool, {
      send: async (s) => {
        again.push(s.endpoint);
        return { statusCode: 201 };
      },
    });
    expect(again.filter((e) => e.endsWith(RUN))).toHaveLength(0); // once per local day, and the dead one is gone
  });

  it("pushes what needs you at once, without content, once; quiet hours hold the push but not the inbox", async () => {
    await call("home", lan, "POST", "/push/subscriptions", { endpoint: `https://push.example.com/instant-${RUN}`, keys: PUSH_KEYS });
    await call("home", lan, "PUT", "/prefs", { timezone: "UTC", quietStart: null, quietEnd: null });
    // Projected directly so the queue row exists before the push job runs (the event path is covered above).
    const requested = (title: string): EventEnvelope => {
      const approvalId = newId();
      return {
        eventId: newId(),
        eventType: "work.approval.requested.v1",
        version: 1,
        aggregateType: "work.approval",
        aggregateId: approvalId,
        actorId: "user:minh",
        occurredAt: new Date().toISOString(),
        payload: { approvalId, title, approverId: "lan", requesterId: "minh" },
      };
    };
    const asA = <T>(fn: () => Promise<T>) => runWithContext({ actorId: "test", requestId: newId() }, fn);
    const sent: { endpoint: string; payload: string }[] = [];
    const fake = {
      send: async (s: { endpoint: string }, payload: string) => {
        sent.push({ endpoint: s.endpoint, payload });
        return { statusCode: 201 };
      },
    };
    const ours = () => sent.filter((s) => s.endpoint === `https://push.example.com/instant-${RUN}`).map((s) => JSON.parse(s.payload));

    const a = requested("Hợp đồng bí mật");
    await asA(() => withTransaction(homePool, (c) => project(a, c)));
    await sendInstantPushes(homePool, fake);
    const url = `/app/work/approvals/${a.payload.approvalId}`;
    expect(ours()).toEqual([{ title: "Có yêu cầu cần bạn duyệt", body: "Mở workspace để xem", url, tag: url }]);
    expect(JSON.stringify(ours())).not.toContain("bí mật"); // nothing sensitive on a lock screen
    sent.length = 0;
    await sendInstantPushes(homePool, fake);
    expect(ours()).toHaveLength(0); // each notice is pushed once

    const h = new Date().getUTCHours();
    await call("home", lan, "PUT", "/prefs", { quietStart: h, quietEnd: (h + 1) % 24 });
    const b = requested("Đêm khuya");
    await asA(() => withTransaction(homePool, (c) => project(b, c)));
    await sendInstantPushes(homePool, fake);
    expect(ours()).toHaveLength(0); // quiet hours: no push...
    const inbox = (await call("home", lan, "GET", "/notifications")).body.action as { url: string }[];
    expect(inbox.some((n) => n.url === `/app/work/approvals/${b.payload.approvalId}`)).toBe(true); // ...but the inbox has it
    await call("home", lan, "PUT", "/prefs", { quietStart: null, quietEnd: null });
  });

  it("task comments notify the owner and assignee, and @mentions are action items without the title", async () => {
    const taskId = newId();
    const commentId = newId();
    const ev: EventEnvelope = {
      eventId: newId(),
      eventType: "work.task.commented.v1",
      version: 1,
      aggregateType: "work.task",
      aggregateId: taskId,
      actorId: "user:huy",
      occurredAt: new Date().toISOString(),
      payload: { taskId, commentId, authorId: "huy", ownerId: "minh", assigneeId: "huy", code: "T-077", title: "Hợp đồng mật", mentions: ["lan"] },
    };
    await runWithContext({ actorId: "test", requestId: newId() }, () => withTransaction(homePool, (c) => project(ev, c)));
    const minhInbox = (await call("home", minh, "GET", "/notifications")).body;
    expect(minhInbox.updates.find((n: { url: string }) => n.url === `/app/work/tasks/${taskId}`)).toMatchObject({
      kind: "task.commented",
      title: "Bình luận mới ở T-077: Hợp đồng mật",
    });
    const lanInbox = (await call("home", lan, "GET", "/notifications")).body;
    const mention = lanInbox.action.find((n: { url: string }) => n.url === `/app/work/tasks/${taskId}`);
    expect(mention).toMatchObject({ kind: "task.mention", title: "Bạn được nhắc tên trong T-077" });
    expect(JSON.stringify(lanInbox)).not.toContain("Hợp đồng mật");
  });

  it("an edited task comment tells only the newly mentioned; a deleted one takes its mentions out of the inbox", async () => {
    const taskId = newId();
    const commentId = newId();
    const env = (eventType: string, payload: Record<string, unknown>): EventEnvelope => ({
      eventId: newId(),
      eventType,
      version: 1,
      aggregateType: "work.task",
      aggregateId: taskId,
      actorId: "user:huy",
      occurredAt: new Date().toISOString(),
      payload,
    });
    const run = (ev: EventEnvelope) => runWithContext({ actorId: "test", requestId: newId() }, () => withTransaction(homePool, (c) => project(ev, c)));
    const url = `/app/work/tasks/${taskId}`;
    const items = async (who: typeof minh) => {
      const b = (await call("home", who, "GET", "/notifications")).body;
      return [...b.action, ...b.updates].filter((n: { url: string }) => n.url === url) as { kind: string }[];
    };
    await run(env("work.task.comment_edited.v1", { taskId, commentId, authorId: "huy", code: "T-078", title: "Báo giá", mentions: ["lan"] }));
    expect((await items(lan)).map((n) => n.kind)).toEqual(["task.mention"]);
    expect(await items(minh)).toEqual([]);
    await run(env("work.task.comment_deleted.v1", { taskId, commentId }));
    expect(await items(lan)).toEqual([]);
  });

  it("page comments notify the people the work module names (owner, last editor, @mentions), once per burst, never the author", async () => {
    const documentId = newId();
    const comment = (authorId: string): EventEnvelope => ({
      eventId: newId(),
      eventType: "work.document.commented.v1",
      version: 1,
      aggregateType: "work.document",
      aggregateId: documentId,
      actorId: `user:${authorId}`,
      occurredAt: new Date().toISOString(),
      payload: { documentId, commentId: newId(), code: "DOC-12", title: "Quy trình onboarding", authorId, notify: ["minh", "lan"], quote: null },
    });
    const run = (ev: EventEnvelope) => runWithContext({ actorId: "test", requestId: newId() }, () => withTransaction(homePool, (c) => project(ev, c)));
    await run(comment("huy"));
    await run(comment("lan"));
    const mine = async (who: typeof minh) =>
      ((await call("home", who, "GET", "/notifications")).body.updates as { url: string; kind: string; title: string }[]).filter((n) => n.url === `/app/work/docs/${documentId}`);
    const minhs = await mine(minh);
    expect(minhs).toHaveLength(1);
    expect(minhs[0]).toMatchObject({ kind: "doc.commented", title: "Bình luận mới ở trang Quy trình onboarding" });
    // lan wrote the second comment: she hears about huy's, not about her own.
    expect(await mine(lan)).toHaveLength(1);
  });

  it("direct messages push once per conversation per 10 minutes, without content, unless muted", async () => {
    await call("home", lan, "POST", "/push/subscriptions", { endpoint: `https://push.example.com/dm-${RUN}`, keys: PUSH_KEYS });
    await call("home", lan, "PUT", "/prefs", { quietStart: null, quietEnd: null, muted: [] });
    const channelId = newId();
    const dm = (body: string): EventEnvelope => ({
      eventId: newId(),
      eventType: "chat.message.created.v1",
      version: 1,
      aggregateType: "chat.message",
      aggregateId: newId(),
      actorId: "user:minh",
      occurredAt: new Date().toISOString(),
      payload: { messageId: newId(), channelId, channelKind: "dm", channelName: null, authorId: "minh", body, mentions: [], recipients: ["lan"] },
    });
    const asA = (fn: (c: pg.PoolClient) => Promise<unknown>) => runWithContext({ actorId: "test", requestId: newId() }, () => withTransaction(homePool, fn));
    const sent: { endpoint: string; payload: string }[] = [];
    const fake = {
      send: async (s: { endpoint: string }, payload: string) => {
        sent.push({ endpoint: s.endpoint, payload });
        return { statusCode: 201 };
      },
    };
    const ours = () => sent.filter((x) => x.endpoint === `https://push.example.com/dm-${RUN}`).map((x) => JSON.parse(x.payload));
    await sendInstantPushes(homePool, { send: async () => ({ statusCode: 201 }) }); // drain pushes queued by earlier tests

    await asA((c) => project(dm("Lương tháng này bí mật"), c));
    await asA((c) => project(dm("Còn nữa"), c));
    await sendInstantPushes(homePool, fake);
    expect(ours()).toEqual([{ title: "Bạn có tin nhắn riêng mới", body: "Mở workspace để xem", url: `/app/chat/${channelId}`, tag: `/app/chat/${channelId}` }]);

    sent.length = 0;
    await call("home", lan, "PUT", "/prefs", { muted: ["dm"] });
    await asA((c) => c.query("UPDATE push_recent SET at = now() - interval '11 minutes' WHERE user_id = 'lan'"));
    await asA((c) => project(dm("Sau khi tắt"), c));
    await sendInstantPushes(homePool, fake);
    expect(ours()).toHaveLength(0);
    await call("home", lan, "PUT", "/prefs", { muted: [] });
  });

  it("reminds the assignee once per due date when a task is due within 24 hours", async () => {
    await call("home", lan, "PUT", "/prefs", { muted: [] });
    const taskId = newId();
    const ev = (version: number, dueAt: string): EventEnvelope => ({
      eventId: newId(),
      eventType: "work.task.updated.v1",
      version: 1,
      aggregateType: "work.task",
      aggregateId: taskId,
      actorId: "user:minh",
      occurredAt: new Date().toISOString(),
      payload: { taskId, title: "Nộp báo cáo thuế", code: "T-901", assigneeId: "lan", ownerId: "minh", status: "todo", version, dueAt, priority: "high" },
    });
    const asA = (fn: (c: pg.PoolClient) => Promise<unknown>) => runWithContext({ actorId: "test", requestId: newId() }, () => withTransaction(homePool, fn));
    const reminders = async () =>
      ((await call("home", lan, "GET", "/notifications")).body.action as { kind: string; url: string; title: string }[]).filter(
        (n) => n.kind === "task.due" && n.url === `/app/work/tasks/${taskId}`,
      );

    await asA((c) => project(ev(1, new Date(Date.now() + 3 * 3600_000).toISOString()), c));
    await sendDueReminders(homePool);
    await sendDueReminders(homePool);
    const once = await reminders();
    expect(once).toHaveLength(1);
    expect(once[0]!.title).toMatch(/^Sắp đến hạn \(.+\): Nộp báo cáo thuế$/);

    await asA((c) => project(ev(2, new Date(Date.now() + 5 * 3600_000).toISOString()), c)); // due date moved
    await sendDueReminders(homePool);
    expect(await reminders()).toHaveLength(2);

    await asA((c) => project(ev(3, new Date(Date.now() + 3 * 86400_000).toISOString()), c)); // not due soon
    await sendDueReminders(homePool);
    expect(await reminders()).toHaveLength(2);
  });

  it("returns an explicit unavailable state for the AI brief when AI is off", async () => {
    expect((await call("home", lan, "POST", "/home/brief")).body).toEqual({ status: "unavailable" });
  });

  it("lists decisions waiting for you and blockers on tasks you own", async () => {
    const d = (await call("work", lan, "POST", "/decisions", { title: "Chốt màu nút: xanh lá", deciderId: "minh" })).body;
    await eventually(async () => (await needsYou(minh)).some((i) => i.kind === "decision" && i.refId === d.id));
    const t = (await call("work", minh, "POST", "/tasks", { title: "Tích hợp VNPay", assigneeId: "lan" })).body;
    const b = (await call("work", lan, "PATCH", `/tasks/${t.id}`, { expectedVersion: t.version, blockedReason: "Chờ API key" })).body;
    await eventually(async () => (await needsYou(minh)).some((i) => i.kind === "blocker" && i.refId === t.id));
    expect((await call("home", minh, "GET", "/home")).body.counts).toMatchObject({ decisions: expect.any(Number), blockers: expect.any(Number) });
    await call("work", minh, "POST", `/decisions/${d.id}/settle`, { action: "decide" });
    await call("work", lan, "PATCH", `/tasks/${t.id}`, { expectedVersion: b.version, blockedReason: null });
    await eventually(async () => {
      const n = await needsYou(minh);
      return !n.some((i) => i.refId === d.id) && !n.some((i) => i.kind === "blocker" && i.refId === t.id);
    });
    // The settled decision reaches everyone's "while you were away" feed, and its proposer is told.
    await eventually(async () => (await call("home", lan, "GET", "/home/away")).body.items.some((a: { key: string }) => a.key === `decision:${d.id}`));
    await eventually(async () => (await call("home", lan, "GET", "/notifications")).body.updates.some((n: { kind: string }) => n.kind === "decision.decided"));
  });

  it("progress check-in prompts are no longer sent (the feature was removed)", async () => {
    const taskId = newId();
    const e: EventEnvelope = {
      eventId: newId(),
      eventType: "work.task.checkin_due.v1",
      version: 1,
      aggregateType: "work.task",
      aggregateId: taskId,
      actorId: "service:checkin-prompts",
      occurredAt: new Date().toISOString(),
      payload: { taskId, code: "T-777", title: "Hợp đồng đối tác", assigneeId: "lan", ownerId: "minh", dueAt: null, progress: null },
    };
    await runWithContext({ actorId: "test", requestId: newId() }, () => withTransaction(homePool, (c) => project(e, c)));
    const b = (await call("home", lan, "GET", "/notifications")).body;
    expect([...b.action, ...b.updates].some((n: { url: string }) => n.url === `/app/work/tasks/${taskId}`)).toBe(false);
  });

  it("a notice is written in the language the reader uses now, bursts fold into one group, and a deleted task keeps no link", async () => {
    const run = (ev: EventEnvelope) => runWithContext({ actorId: "test", requestId: newId() }, () => withTransaction(homePool, (c) => project(ev, c)));
    const taskId = newId();
    const comment = (by: string) =>
      run({
        eventId: newId(),
        eventType: "work.task.commented.v1",
        version: 1,
        aggregateType: "work.task",
        aggregateId: taskId,
        actorId: `user:${by}`,
        occurredAt: new Date().toISOString(),
        payload: { taskId, commentId: newId(), authorId: by, ownerId: "minh", assigneeId: "lan", code: "T-215", title: "Sponsorship packages", mentions: [] },
      });
    await comment("huy");
    await comment("tam");
    await comment("huy");
    const mine = async (locale: string) => {
      const b = (await call("home", minh, "GET", "/notifications", undefined, { "x-locale": locale })).body;
      return {
        b,
        rows: [...b.action, ...b.updates].filter((n: { url: string }) => n.url === `/app/work/tasks/${taskId}`) as {
          id: string;
          title: string;
          groupKey: string;
          gone: boolean;
          url: string;
        }[],
      };
    };
    const en = await mine("en");
    expect(en.rows.map((n) => n.title)).toEqual(Array(3).fill("New comment on T-215: Sponsorship packages"));
    expect((await mine("vi")).rows[0]!.title).toBe("Bình luận mới ở T-215: Sponsorship packages");
    const group = (en.b.groups as { key: string; count: number; actorIds: string[]; params: { code: string } }[]).find((g) => g.key === `task.commented:${taskId}`);
    expect(group).toMatchObject({ count: 3, actorIds: ["huy", "tam"], params: { code: "T-215" } });

    // The task goes: its notices stay, say so, and lead nowhere; they no longer form a group.
    await run({
      eventId: newId(),
      eventType: "work.task.deleted.v1",
      version: 1,
      aggregateType: "work.task",
      aggregateId: taskId,
      actorId: "user:minh",
      occurredAt: new Date().toISOString(),
      payload: { taskId },
    });
    const after = await mine("en");
    expect(after.rows.every((n) => n.gone && n.url === "")).toBe(true);
    expect((after.b.groups as { key: string }[]).some((g) => g.key === `task.commented:${taskId}`)).toBe(false);

    // "Mark these as read" settles a whole group.
    const approvals = [newId(), newId()];
    for (const approvalId of approvals)
      await run({
        eventId: newId(),
        eventType: "work.approval.requested.v1",
        version: 1,
        aggregateType: "work.approval",
        aggregateId: approvalId,
        actorId: "user:huy",
        occurredAt: new Date().toISOString(),
        payload: { approvalId, approverId: "minh", requesterId: "huy", title: "Laptop" },
      });
    expect(((await mine("en")).b.groups as { key: string; count: number }[]).find((g) => g.key === "approval.requested")!.count).toBeGreaterThanOrEqual(2);
    expect((await call("home", minh, "POST", "/notifications/read-group", { key: "approval.requested" })).status).toBe(204);
    expect(((await mine("en")).b.groups as { key: string }[]).some((g) => g.key === "approval.requested")).toBe(false);
  });

  it("Nhắc tôi: a reminder arrives once, at its time, only for its owner; bad links and past times are refused", async () => {
    const at = new Date(Date.now() + 3600_000).toISOString();
    const r = await call("home", lan, "POST", "/reminders", { at, title: "Minh: gửi báo giá cho khách", url: "/app/chat/c1?m=m1" });
    expect(r.status).toBe(201);
    expect((await call("home", lan, "GET", "/reminders")).body.reminders.map((x: { id: string }) => x.id)).toContain(r.body.id);
    expect((await call("home", lan, "POST", "/reminders", { at, title: "x", url: "https://evil.example" })).status).toBe(400);
    expect((await call("home", lan, "POST", "/reminders", { at: "2020-01-01T00:00:00Z", title: "x", url: "/app/home" })).status).toBe(400);
    // Not yet due: nothing is sent.
    await sendPersonalReminders(homePool);
    const mine = async () => ((await call("home", lan, "GET", "/notifications")).body.action as { kind: string; title: string }[]).filter((n) => n.kind === "reminder");
    expect(await mine()).toHaveLength(0);
    // Its time comes (moved back in the database): sent once, even if the job runs twice.
    await runWithContext({ actorId: "test", requestId: newId() }, () =>
      withTransaction(homePool, (c) => c.query("UPDATE reminders SET remind_at = now() - interval '1 minute' WHERE id = $1", [r.body.id])),
    );
    await sendPersonalReminders(homePool);
    await sendPersonalReminders(homePool);
    expect((await mine()).map((n) => n.title)).toEqual(["Nhắc bạn: Minh: gửi báo giá cho khách"]);
    expect((await call("home", minh, "GET", "/notifications")).body.action.some((n: { kind: string }) => n.kind === "reminder")).toBe(false);
    expect((await call("home", lan, "GET", "/reminders")).body.reminders).toEqual([]);
  });

  it("watchers of a page are told when it changes, once per half hour however often it autosaves", async () => {
    const doc = (await call("work", minh, "POST", "/docs", { title: "Quy chế thưởng", content: "v1", visibility: "private" })).body;
    await call("work", minh, "PUT", `/docs/${doc.id}/sharing`, { userIds: ["lan"] });
    expect((await call("work", lan, "PUT", `/docs/${doc.id}/watch`)).body).toEqual({ watching: true });
    expect((await call("work", lan, "GET", `/docs/${doc.id}`)).body.context.watching).toBe(true);
    let v: number = (await call("work", minh, "GET", `/docs/${doc.id}`)).body.document.version;
    for (const text of ["v2", "v3", "v4"]) v = (await call("work", minh, "PUT", `/docs/${doc.id}`, { content: text, baseVersion: v })).body.current_version;
    const mine = async () =>
      (await call("home", lan, "GET", "/notifications")).body.updates.filter((n: { kind: string; url: string }) => n.kind === "doc.updated" && n.url.endsWith(doc.id));
    await eventually(async () => (await mine()).length === 1);
    await new Promise((r) => setTimeout(r, 800));
    expect(await mine()).toHaveLength(1);
    // The editor never notifies themself, and someone who stops watching hears nothing more.
    expect((await call("home", minh, "GET", "/notifications")).body.updates.some((n: { kind: string; url: string }) => n.kind === "doc.updated" && n.url.endsWith(doc.id))).toBe(
      false,
    );
  });

  it("feeds 'while you were away': tasks from chat, shared doc edits (collapsed), agent results", async () => {
    const source = { type: "chat.message", messageId: newId(), channelId: newId() };
    const t = (await call("work", minh, "POST", "/tasks", { title: "Gửi báo giá", assigneeId: "lan", source })).body;
    const doc = (await call("work", minh, "POST", "/docs", { title: "Kế hoạch Q4", content: "v1", visibility: "private" })).body;
    await call("work", minh, "PUT", `/docs/${doc.id}/sharing`, { userIds: ["lan"] });
    let v: number = (await call("work", minh, "GET", `/docs/${doc.id}`)).body.document.version;
    for (const text of ["v2", "v3"]) v = (await call("work", minh, "PUT", `/docs/${doc.id}`, { content: text, baseVersion: v })).body.current_version;
    const agentRun: EventEnvelope = {
      eventId: newId(),
      eventType: "ai.agent.run.completed.v1",
      version: 1,
      aggregateType: "ai.agent",
      aggregateId: "ag1",
      actorId: "agent:ag1",
      occurredAt: new Date().toISOString(),
      payload: {
        agentId: "ag1",
        agentName: "Project Agent",
        askerId: "lan",
        channelId: "c1",
        messageId: "m1",
        prompt: "Tiến độ dự án Alpha?",
        answer: "Còn 3 việc trễ.",
        toolCalls: [],
      },
    };
    await runWithContext({ actorId: "test", requestId: newId() }, () =>
      withTransaction(homePool, async (c) => {
        await project(agentRun, c);
      }),
    );
    await eventually(async () => {
      const items = (await call("home", lan, "GET", "/home/away")).body.items as { key: string; kind: string; count: number }[];
      const docRow = items.find((i) => i.key === `doc:${doc.id}`);
      return items.some((i) => i.key === `task:${t.id}` && i.kind === "extracted_task") && !!docRow && docRow.count >= 2 && items.some((i) => i.kind === "agent_result");
    });
    // Nothing the user did themselves; and "caught up" empties the feed.
    expect((await call("home", minh, "GET", "/home/away")).body.items.some((i: { key: string }) => i.key === `doc:${doc.id}`)).toBe(false);
    await call("home", lan, "POST", "/home/caught-up");
    expect((await call("home", lan, "GET", "/home/away")).body.items).toEqual([]);
  });

  it("notification settings: muted categories skip the inbox; the daily digest emails what needs you, once", async () => {
    const { sendDigests } = await import("../../src/modules/home/digest.js");
    const sent: { to: string; subject: string; text: string }[] = [];
    const mailer = {
      send: async (m: { to: string; subject: string; text: string }) => {
        sent.push(m);
      },
    };
    expect((await call("home", lan, "PUT", "/prefs", { muted: ["task"], digestHour: 0, emailDigest: true, timezone: "Asia/Ho_Chi_Minh" })).body).toMatchObject({
      muted: ["task"],
      digestHour: 0,
    });
    expect((await call("home", lan, "PUT", "/prefs", { muted: ["wallet"] })).status).toBe(400);
    const joined: EventEnvelope = {
      eventId: newId(),
      eventType: "identity.member.joined.v1",
      version: 1,
      aggregateType: "identity.member",
      aggregateId: "lan",
      actorId: "user:lan",
      occurredAt: new Date().toISOString(),
      payload: { userId: "lan", email: `lan-${RUN}@example.com`, displayName: "Lan" },
    };
    await runWithContext({ actorId: "test", requestId: newId() }, () => withTransaction(homePool, (c) => project(joined, c)));
    const t = (await call("work", minh, "POST", "/tasks", { title: "Việc bị tắt thông báo", assigneeId: "lan" })).body;
    await eventually(async () => (await needsYou(lan)).some((i) => i.refId === t.id));
    const inbox = (await call("home", lan, "GET", "/notifications")).body.action as { kind: string; url: string }[];
    expect(inbox.some((n) => n.url.includes(t.id))).toBe(false); // muted: no inbox row for the assignment
    await runWithContext({ actorId: "test", requestId: newId() }, () =>
      withTransaction(homePool, (c) => c.query("UPDATE user_prefs SET last_digest_date = NULL WHERE user_id = 'lan'")),
    );
    await sendDigests(homePool, mailer as never, "http://localhost:3000", 10_000);
    const mine = sent.filter((m) => m.to === `lan-${RUN}@example.com`);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.text).toContain("Việc bị tắt thông báo");
    await sendDigests(homePool, mailer as never, "http://localhost:3000", 10_000);
    expect(sent.filter((m) => m.to === `lan-${RUN}@example.com`)).toHaveLength(1);

    // Mondays, a manager's digest also says where their team stands (the Follow-up view, read as them).
    await runWithContext({ actorId: "test", requestId: newId() }, () =>
      withTransaction(homePool, (c) => c.query("UPDATE user_prefs SET last_digest_date = NULL WHERE user_id = 'lan'")),
    );
    const team = {
      totals: { overdue: 1, stale: 0, blocked: 0, done7: 3 },
      people: [{ displayName: "Huy", late: [], tasks: [{ title: "Báo cáo quý", overdue: true, blockedReason: null, status: "todo" }] }],
    };
    await sendDigests(
      homePool,
      mailer as never,
      "http://localhost:3000",
      10_000,
      async () => team,
      () => true,
      async () => ({ done7: 3, inProgress: 2, overdue: 0 }),
    );
    const monday = sent.filter((m) => m.to === `lan-${RUN}@example.com`).at(-1)!;
    expect(monday.text).toContain("Đội của bạn tuần này");
    expect(monday.text).toContain("1 việc trễ hạn");
    expect(monday.text).toContain("Huy: Báo cáo quý (trễ hạn)");
    expect(monday.text).toContain("Tuần qua bạn đã xong 3 việc · 2 việc đang làm.");
  });
});
