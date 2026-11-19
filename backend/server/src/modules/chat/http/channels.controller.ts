import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Req } from "@nestjs/common";
import { assertAllowed, parse, requirePrincipal } from "@workspace/service-kit";
import { authorize, withTransaction } from "@workspace/shared";
import type { Request } from "express";
import { z } from "zod";
import {
  assertCanRead,
  assertKnownMembers,
  assertMember,
  createChannel,
  emit,
  Forbidden,
  getChannel,
  Invalid,
  memberIds,
  membership,
  NotFound,
  openDm,
  updateChannel,
  waitForKnownMembers,
} from "../domain.js";

import { ChatControllerBase } from "./base.controller.js";
import { guard } from "./common.js";

/** Channels and DMs: list, create, join, members, settings and per-person notification preferences. */
@Controller()
export class ChannelsController extends ChatControllerBase {
  @Get("channels")
  async channels(@Req() req: Request) {
    const p = requirePrincipal(req);
    assertAllowed(p, "channel.read");
    return withTransaction(this.pool, async (c) => {
      // Unread mentions are only counted where there is something unread at all: a person's channel list is mostly
      // channels they are up to date with, and counting walks the channel's history from last_read_seq.
      const mine = await c.query(
        `SELECT ch.id, ch.kind, ch.name, ch.display_name AS "displayName", ch.topic, ch.last_seq::bigint AS "lastSeq", cm.last_read_seq::bigint AS "lastReadSeq",
                (ch.last_seq - cm.last_read_seq)::int AS unread,
                CASE WHEN ch.last_seq > cm.last_read_seq
                     THEN (SELECT count(*)::int FROM messages m WHERE m.channel_id = ch.id AND m.seq > cm.last_read_seq AND m.mentions @> ARRAY[$1]::text[])
                     ELSE 0 END AS mentions,
                CASE WHEN ch.kind = 'dm' THEN (SELECT user_id FROM channel_members o WHERE o.channel_id = ch.id AND o.user_id <> $1 LIMIT 1) END AS "dmUserId",
                cm.starred, (cm.muted OR coalesce(cm.muted_until > now(), false) OR coalesce(cm.notify, '') = 'none') AS muted, cm.notify, cm.muted_until AS "mutedUntil",
                (SELECT count(*)::int FROM channel_members x WHERE x.channel_id = ch.id) AS "memberCount",
                (SELECT m.created_at FROM messages m WHERE m.channel_id = ch.id AND m.thread_root_id IS NULL ORDER BY m.seq DESC LIMIT 1) AS "lastMessageAt"
           FROM channel_members cm JOIN channels ch ON ch.id = cm.channel_id
          WHERE cm.user_id = $1 AND NOT ch.archived ORDER BY ch.kind, ch.name NULLS LAST`,
        [p.id],
      );
      const browse = await c.query(
        `SELECT id, name, display_name AS "displayName", topic, (SELECT count(*)::int FROM channel_members x WHERE x.channel_id = ch.id) AS "memberCount",
                (SELECT m.created_at FROM messages m WHERE m.channel_id = ch.id AND m.thread_root_id IS NULL ORDER BY m.seq DESC LIMIT 1) AS "lastMessageAt"
           FROM channels ch WHERE kind = 'public' AND NOT archived
            AND NOT EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = ch.id AND cm.user_id = $1) ORDER BY name LIMIT 200`,
        [p.id],
      );
      // Archived channels the person was in (or public ones), so they can still be found and restored.
      const archived = await c.query(
        `SELECT id, name, display_name AS "displayName", topic FROM channels ch WHERE archived AND kind IN ('public', 'private')
            AND (kind = 'public' OR EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = ch.id AND cm.user_id = $1)) ORDER BY name LIMIT 200`,
        [p.id],
      );
      return { channels: mine.rows.map((r) => ({ ...r, lastSeq: Number(r.lastSeq), lastReadSeq: Number(r.lastReadSeq) })), browsable: browse.rows, archived: archived.rows };
    });
  }

  @Post("channels")
  async createChannel(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "channel.create");
    const memberIds = z.array(z.string().min(1)).max(500).default([]);
    const b = parse(
      z.discriminatedUnion("kind", [
        z.object({
          kind: z.enum(["public", "private"]),
          name: z
            .string()
            .trim()
            .min(1)
            .max(80)
            .regex(/^[\p{L}\p{N}_-]+$/u, "letters, numbers, - and _ only"),
          // How people read it ("Kỹ thuật"); the handle above is what # links use.
          displayName: z.string().trim().min(1).max(80).optional(),
          topic: z.string().max(250).default(""),
          memberIds,
        }),
        // A group chat is a DM with several people: no # handle (nothing links to it), named after its members.
        z.object({
          kind: z.literal("group"),
          displayName: z.string().trim().min(1).max(80),
          memberIds: z.array(z.string().min(1)).min(2).max(50),
        }),
      ]),
      body,
    );
    await waitForKnownMembers(
      this.pool,
      b.memberIds.filter((u) => u !== p.id),
    );
    const input = b.kind === "group" ? { kind: b.kind, name: null, displayName: b.displayName, topic: "", memberIds: b.memberIds } : b;
    const r = await guard(() => withTransaction(this.pool, (c) => createChannel(c, p, input)));
    this.rt.joinChannel(r.members, r.id);
    return { id: r.id };
  }

  @Post("dms")
  async openDm(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "message.post");
    const b = parse(z.object({ userId: z.string().min(1) }), body);
    if (b.userId !== p.id) await waitForKnownMembers(this.pool, [b.userId]);
    const r = await guard(() => withTransaction(this.pool, (c) => openDm(c, p, b.userId)));
    if (r.created) this.rt.joinChannel([p.id, b.userId], r.id);
    return { id: r.id };
  }

  @Post("channels/:id/join")
  @HttpCode(204)
  async join(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "channel.read");
    await guard(() =>
      withTransaction(this.pool, async (c) => {
        const ch = await getChannel(c, id);
        if (ch.kind !== "public") throw new NotFound("channel not found");
        await c.query("INSERT INTO channel_members (channel_id, user_id, last_read_seq) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [id, p.id, ch.last_seq]);
        await emit(c, "chat.channel.member_added.v1", "chat.channel", id, { channelId: id, userIds: [p.id] });
      }),
    );
    this.rt.joinChannel([p.id], id);
  }

  @Post("channels/:id/members")
  @HttpCode(204)
  async addMembers(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(z.object({ userIds: z.array(z.string().min(1)).min(1).max(200) }), body);
    await waitForKnownMembers(this.pool, b.userIds);
    await guard(() =>
      withTransaction(this.pool, async (c) => {
        const ch = await assertMember(c, p, id);
        if (ch.kind === "dm") throw new Invalid("cannot add members to a DM");
        const m = await membership(c, id, p.id);
        if (m?.role !== "admin" && !authorize(p, "channel.manage").allowed) throw new Forbidden("channel admin required");
        await assertKnownMembers(c, b.userIds);
        for (const u of b.userIds) {
          await c.query("INSERT INTO channel_members (channel_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [id, u]);
        }
        await emit(c, "chat.channel.member_added.v1", "chat.channel", id, { channelId: id, userIds: b.userIds });
      }),
    );
    this.rt.joinChannel(b.userIds, id);
  }

  /** One channel's settings and what the caller may do with it (also for archived channels). */
  @Get("channels/:id")
  async channel(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    return guard(() =>
      withTransaction(this.pool, async (c) => {
        const ch = await assertCanRead(c, p, id);
        const m = await membership(c, id, p.id);
        const flags = (await c.query<{ is_default: boolean; auto_join: boolean }>("SELECT is_default, auto_join FROM channels WHERE id = $1", [id])).rows[0];
        const isDefault = flags?.is_default ?? false;
        const workspaceAdmin = authorize(p, "channel.manage").allowed;
        const manage = (ch.kind === "public" || ch.kind === "private") && (m?.role === "admin" || workspaceAdmin);
        return {
          id: ch.id,
          kind: ch.kind,
          name: ch.name,
          displayName: ch.display_name ?? null,
          topic: ch.topic,
          archived: ch.archived,
          isDefault,
          autoJoin: isDefault || (flags?.auto_join ?? false),
          // Only workspace admins choose which channels every newcomer joins.
          canSetAutoJoin: ch.kind === "public" && !isDefault && workspaceAdmin,
          member: !!m,
          canManage: manage,
          // "Đã xem" in direct and group messages: how far each other member has read (not shown for channels).
          readers:
            ch.kind === "dm" || ch.kind === "group"
              ? (
                  await c.query<{ userId: string; seq: string }>(`SELECT user_id AS "userId", last_read_seq AS seq FROM channel_members WHERE channel_id = $1 AND user_id <> $2`, [
                    id,
                    p.id,
                  ])
                ).rows.map((x) => ({ userId: x.userId, seq: Number(x.seq) }))
              : [],
        };
      }),
    );
  }

  @Patch("channels/:id")
  async updateChannel(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(
      z.object({
        name: z
          .string()
          .trim()
          .min(1)
          .max(80)
          .regex(/^[\p{L}\p{N}_-]+$/u, "letters, numbers, - and _ only")
          .optional(),
        // An empty string clears it (the handle shows again).
        displayName: z.string().trim().max(80).optional(),
        topic: z.string().max(250).optional(),
        archived: z.boolean().optional(),
        autoJoin: z.boolean().optional(),
      }),
      body,
    );
    const r = await guard(() => withTransaction(this.pool, (c) => updateChannel(c, p, id, b)));
    this.rt.toChannel(id, "channel.updated", r);
    return r;
  }

  @Delete("channels/:id/members/:userId")
  @HttpCode(204)
  async removeMember(@Req() req: Request, @Param("id") id: string, @Param("userId") userId: string) {
    const p = requirePrincipal(req);
    await guard(() =>
      withTransaction(this.pool, async (c) => {
        const ch = await assertMember(c, p, id);
        if (ch.kind === "dm") throw new Invalid("cannot leave a DM");
        const m = await membership(c, id, p.id);
        if (userId !== p.id && m?.role !== "admin" && !authorize(p, "channel.manage").allowed) throw new Forbidden("channel admin required");
        await c.query("DELETE FROM channel_members WHERE channel_id = $1 AND user_id = $2", [id, userId]);
        await emit(c, "chat.channel.member_removed.v1", "chat.channel", id, { channelId: id, userId });
      }),
    );
    this.rt.leaveChannel(userId, id);
  }

  /**
   * Star a conversation, choose how it notifies (every message, mentions only, nothing) and mute it for a
   * while ("1h", "8h", "24h", "1w"), until turned back on ("forever"), or unmute ("off"). Caller only.
   */
  @Put("channels/:id/prefs")
  async prefs(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(
      z.object({
        starred: z.boolean().optional(),
        muted: z.boolean().optional(),
        notify: z.enum(["all", "mentions", "none"]).optional(),
        muteFor: z.enum(["1h", "8h", "24h", "1w", "forever", "off"]).optional(),
      }),
      body,
    );
    const interval = { "1h": "1 hour", "8h": "8 hours", "24h": "1 day", "1w": "7 days" } as const;
    // muted: forever; muted_until: for a while. Setting one clears the other.
    const mute = b.muteFor === undefined ? (b.muted === undefined ? null : b.muted) : b.muteFor === "forever";
    const until = b.muteFor === undefined ? (b.muted === undefined ? undefined : null) : b.muteFor in interval ? interval[b.muteFor as keyof typeof interval] : null;
    return guard(() =>
      withTransaction(this.pool, async (c) => {
        await assertMember(c, p, id);
        const r = await c.query<{ starred: boolean; muted: boolean; notify: string | null; mutedUntil: Date | null }>(
          `UPDATE channel_members SET starred = coalesce($3, starred), muted = coalesce($4, muted), notify = coalesce($5, notify),
                  muted_until = CASE WHEN $6::boolean THEN (CASE WHEN $7::text IS NULL THEN NULL ELSE now() + $7::interval END) ELSE muted_until END
            WHERE channel_id = $1 AND user_id = $2
            RETURNING starred, (muted OR coalesce(muted_until > now(), false) OR coalesce(notify, '') = 'none') AS muted, notify, muted_until AS "mutedUntil"`,
          [id, p.id, b.starred ?? null, mute, b.notify ?? null, until !== undefined, until ?? null],
        );
        return r.rows[0]!;
      }),
    );
  }

  @Get("channels/:id/members")
  async members(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    return guard(() =>
      withTransaction(this.pool, async (c) => {
        await assertCanRead(c, p, id);
        return { userIds: await memberIds(c, id) };
      }),
    );
  }
}
