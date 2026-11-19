import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Post, Query, Req, Res } from "@nestjs/common";
import { assertAllowed, parse, requirePrincipal } from "@workspace/service-kit";
import { authorize, recordAudit, withTransaction } from "@workspace/shared";
import type { Request, Response } from "express";
import { z } from "zod";
import { assertCanRead, assertMember, emit, Forbidden, Invalid, loadMessage, NotFound, parseMentions, postMessage, selectMessages } from "../domain.js";
import { bindAttachments } from "../files.js";

import { ChatControllerBase } from "./base.controller.js";
import { attachment, guard } from "./common.js";

/** Messages: history, threads, posting, edits, forwarding, reactions, links to work items and polls. */
@Controller()
export class MessagesController extends ChatControllerBase {
  /** Newest-first page; pass before=<seq> for older pages (cursor, never offset). */
  @Get("channels/:id/messages")
  async messages(@Req() req: Request, @Param("id") id: string, @Query("before") before?: string, @Query("after") after?: string, @Query("limit") limit?: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "message.read");
    const n = Math.min(Math.max(Number(limit ?? 50) || 50, 1), 100);
    return guard(() =>
      withTransaction(this.pool, async (c) => {
        await assertCanRead(c, p, id);
        if (after !== undefined) {
          // Gap recovery after reconnect: everything newer than the client's last seq.
          const rows = await selectMessages(c, "m.channel_id = $1 AND m.thread_root_id IS NULL AND m.seq > $2", [id, Number(after) || 0], p.id, "m.seq ASC", n);
          return { messages: rows, nextBefore: null };
        }
        const rows = await selectMessages(
          c,
          "m.channel_id = $1 AND m.thread_root_id IS NULL AND ($2::bigint IS NULL OR m.seq < $2)",
          [id, before ? Number(before) : null],
          p.id,
          "m.seq DESC",
          n,
        );
        return { messages: rows, nextBefore: rows.length === n ? rows.at(-1)!.seq : null };
      }),
    );
  }

  @Get("messages/:id/thread")
  async thread(@Req() req: Request, @Param("id") id: string, @Query("after") after?: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "message.read");
    return guard(() =>
      withTransaction(this.pool, async (c) => {
        const root = await loadMessage(c, id, p.id);
        await assertCanRead(c, p, root.channelId);
        const replies = await selectMessages(c, "m.thread_root_id = $1 AND m.seq > $2", [id, Number(after ?? 0) || 0], p.id, "m.seq ASC", 200);
        const links = (await c.query(`SELECT kind, ref_id AS "refId", title, created_by AS "createdBy" FROM thread_links WHERE root_id = $1 ORDER BY created_at`, [id])).rows;
        return { root, replies, links };
      }),
    );
  }

  @Post("channels/:id/messages")
  async post(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "message.post");
    const b = parse(
      z
        .object({
          body: z.string().trim().max(20000).default(""),
          clientMsgId: z.string().min(8).max(64).nullable().default(null),
          threadRootId: z.string().length(26).nullable().default(null),
          // File ids from POST channels/:id/files; metadata is read from the server, never trusted from the client.
          attachments: z
            .array(z.union([z.string().length(26), attachment.transform((a) => a.fileId)]))
            .max(10)
            .default([]),
        })
        .refine((x) => x.body.length > 0 || x.attachments.length > 0, "a message needs text or an attachment"),
      body,
    );
    const r = await guard(() =>
      withTransaction(this.pool, async (c) => {
        await assertMember(c, p, id);
        return postMessage(c, {
          channelId: id,
          body: b.body,
          clientMsgId: b.clientMsgId,
          threadRootId: b.threadRootId,
          attachments: [],
          author: { id: p.id, type: p.type === "agent" ? "agent" : "user" },
          bindAttachments: b.attachments.length ? (messageId) => bindAttachments(c, p, id, messageId, [...new Set(b.attachments)]) : undefined,
        });
      }),
    );
    if (r.created) {
      this.rt.toChannel(id, "message.created", r.message);
      if (b.threadRootId) this.rt.toChannel(id, "thread.updated", { rootId: b.threadRootId, channelId: id });
    }
    return r.message;
  }

  @Patch("messages/:id")
  async edit(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(z.object({ body: z.string().trim().min(1).max(20000) }), body);
    const msg = await guard(() =>
      withTransaction(this.pool, async (c) => {
        const m = await loadMessage(c, id, p.id);
        if (m.authorId !== p.id) throw new Forbidden("only the author can edit");
        if (m.deletedAt) throw new Invalid("message deleted");
        // Editing is posting: only while still a member of a live channel (deleting one's own message stays possible).
        await assertMember(c, p, m.channelId);
        await c.query("UPDATE messages SET body = $2, edited_at = now(), mentions = $3 WHERE id = $1", [id, b.body, parseMentions(b.body)]);
        await emit(c, "chat.message.updated.v1", "chat.message", id, { messageId: id, channelId: m.channelId, body: b.body });
        return loadMessage(c, id, p.id);
      }),
    );
    this.rt.toChannel(msg.channelId, "message.updated", msg);
    return msg;
  }

  /**
   * "Chuyển tiếp": copies a message the caller can read into a conversation they belong to, marked with
   * where it came from; an optional note is posted just before it. Files are listed by name, not copied.
   */
  @Post("messages/:id/forward")
  async forward(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "message.post");
    const b = parse(z.object({ channelId: z.string().min(10).max(40), note: z.string().trim().max(4000).default("") }), body);
    const posted = await guard(() =>
      withTransaction(this.pool, async (c) => {
        const m = await loadMessage(c, id, p.id);
        const from = await assertCanRead(c, p, m.channelId);
        if (m.deletedAt) throw new Invalid("message deleted");
        await assertMember(c, p, b.channelId);
        const author = { id: p.id, type: "user" as const };
        const out = [];
        if (b.note) out.push((await postMessage(c, { channelId: b.channelId, body: b.note, clientMsgId: null, threadRootId: null, attachments: [], author })).message);
        const files = (m.attachments as { name?: string }[]).map((a) => `📎 ${a.name ?? ""}`).join("\n");
        const text = [m.body, files].filter(Boolean).join("\n").slice(0, 20000) || "📎";
        // Only a public channel's name travels with the copy: the readers of the destination need not belong to a private source.
        const forwardOf = {
          messageId: m.id,
          channelId: m.channelId,
          channelKind: from.kind,
          channelName: from.kind === "public" ? from.name : null,
          authorId: m.authorId,
          createdAt: m.createdAt,
        };
        out.push((await postMessage(c, { channelId: b.channelId, body: text, clientMsgId: null, threadRootId: null, attachments: [], author, forwardOf })).message);
        return out;
      }),
    );
    for (const m of posted) this.rt.toChannel(b.channelId, "message.created", m);
    return { channelId: b.channelId, messages: posted };
  }

  @Delete("messages/:id")
  @HttpCode(204)
  async remove(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    const m = await guard(() =>
      withTransaction(this.pool, async (c) => {
        const m = await loadMessage(c, id, p.id);
        if (m.authorId !== p.id && !authorize(p, "message.delete_any").allowed) throw new Forbidden("cannot delete this message");
        await c.query("UPDATE messages SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL", [id]);
        await emit(c, "chat.message.deleted.v1", "chat.message", id, { messageId: id, channelId: m.channelId });
        // A moderator removing someone else's message goes to the audit trail (ADR 0025): never the text, and a
        // private conversation only by its kind. People deleting their own messages are not traced.
        if (m.authorId !== p.id) {
          const ch = (await c.query<{ kind: string; name: string | null }>("SELECT kind, name FROM channels WHERE id = $1", [m.channelId])).rows[0];
          await recordAudit(c, {
            action: "chat.message.deleted",
            targetType: "message",
            targetId: id,
            targetLabel: ch?.kind === "public" && ch.name ? `#${ch.name}` : null,
            meta: { channelId: m.channelId, kind: ch?.kind ?? "private", authorId: m.authorId },
          });
        }
        return m;
      }),
    );
    this.rt.toChannel(m.channelId, "message.deleted", { id, channelId: m.channelId });
  }

  /** The author hides the link previews of their message (for good: an edit does not bring them back). */
  @Delete("messages/:id/previews")
  @HttpCode(204)
  async hidePreviews(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    const m = await guard(() =>
      withTransaction(this.pool, async (c) => {
        const m = await loadMessage(c, id, p.id);
        if (m.authorId !== p.id) throw new Forbidden("only the author can hide the previews");
        await c.query("UPDATE messages SET previews_hidden = true, link_previews = '[]'::jsonb WHERE id = $1", [id]);
        return m;
      }),
    );
    this.rt.toChannel(m.channelId, "message.previews", { messageId: id, channelId: m.channelId, linkPreviews: [] });
  }

  /**
   * A preview's thumbnail, stored when the page was fetched (unfurl.ts) and served from here, so the web app never
   * loads images from arbitrary sites. Only for a card the message shows, to people who can read the message.
   */
  @Get("messages/:id/previews/:previewId/image")
  async previewImage(@Req() req: Request, @Res() res: Response, @Param("id") id: string, @Param("previewId") previewId: string) {
    const p = requirePrincipal(req);
    const row = await guard(() =>
      withTransaction(this.pool, async (c) => {
        const m = await loadMessage(c, id, p.id);
        await assertCanRead(c, p, m.channelId);
        if (!m.linkPreviews.some((x) => x.id === previewId && x.image)) return undefined;
        return (await c.query<{ image: Buffer | null; image_type: string | null }>("SELECT image, image_type FROM link_previews WHERE id = $1", [previewId])).rows[0];
      }),
    );
    if (!row?.image || !row.image_type) throw new NotFoundException();
    res.setHeader("content-type", row.image_type);
    res.setHeader("cache-control", "private, max-age=86400");
    res.setHeader("x-content-type-options", "nosniff");
    res.end(row.image);
  }

  @Post("messages/:id/reactions")
  async react(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(z.object({ emoji: z.string().min(1).max(32) }), body);
    const msg = await guard(() =>
      withTransaction(this.pool, async (c) => {
        const m = await loadMessage(c, id, p.id);
        await assertMember(c, p, m.channelId);
        const del = await c.query("DELETE FROM reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3", [id, p.id, b.emoji]);
        if (!del.rowCount) await c.query("INSERT INTO reactions (message_id, user_id, emoji) VALUES ($1,$2,$3)", [id, p.id, b.emoji]);
        return loadMessage(c, id, p.id);
      }),
    );
    this.rt.toChannel(msg.channelId, "reaction.updated", { messageId: id, channelId: msg.channelId, userId: p.id, emoji: b.emoji });
    return msg;
  }

  /** Links a thread to its project or document. Members of the channel may link; the title is display-only. */
  @Post("messages/:id/links")
  @HttpCode(204)
  async link(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(z.object({ kind: z.enum(["project", "document"]), refId: z.string().length(26), title: z.string().trim().min(1).max(300) }), body);
    await guard(() =>
      withTransaction(this.pool, async (c) => {
        const root = await loadMessage(c, id, p.id);
        if (root.threadRootId) throw new Invalid("link the thread's first message");
        await assertMember(c, p, root.channelId);
        await c.query("INSERT INTO thread_links (root_id, kind, ref_id, title, created_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING", [id, b.kind, b.refId, b.title, p.id]);
      }),
    );
  }

  @Delete("messages/:id/links/:kind/:refId")
  @HttpCode(204)
  async unlink(@Req() req: Request, @Param("id") id: string, @Param("kind") kind: string, @Param("refId") refId: string) {
    const p = requirePrincipal(req);
    await guard(() =>
      withTransaction(this.pool, async (c) => {
        const root = await loadMessage(c, id, p.id);
        await assertMember(c, p, root.channelId);
        await c.query("DELETE FROM thread_links WHERE root_id = $1 AND kind = $2 AND ref_id = $3", [id, kind, refId]);
      }),
    );
  }

  /** Polls: a message with a question and options; votes update live. */
  @Post("channels/:id/polls")
  async createPoll(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "message.post");
    const b = parse(
      z.object({
        question: z.string().trim().min(1).max(300),
        options: z.array(z.string().trim().min(1).max(120)).min(2).max(10),
        multi: z.boolean().default(false),
        threadRootId: z.string().nullable().default(null),
      }),
      body,
    );
    const r = await guard(() =>
      withTransaction(this.pool, async (c) => {
        await assertMember(c, p, id);
        const out = await postMessage(c, {
          channelId: id,
          body: `📊 ${b.question}`,
          clientMsgId: null,
          threadRootId: b.threadRootId,
          attachments: [],
          author: { id: p.id, type: "user" },
        });
        const options = b.options.map((text, i) => ({ id: `o${i + 1}`, text }));
        await c.query("INSERT INTO polls (message_id, question, options, multi) VALUES ($1,$2,$3,$4)", [out.message.id, b.question, JSON.stringify(options), b.multi]);
        return loadMessage(c, out.message.id, p.id);
      }),
    );
    this.rt.toChannel(id, "message.created", r);
    return r;
  }

  @Post("messages/:id/vote")
  async vote(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(z.object({ optionIds: z.array(z.string().min(1).max(8)).max(10) }), body);
    const out = await guard(() =>
      withTransaction(this.pool, async (c) => {
        const m = await loadMessage(c, id, p.id);
        await assertMember(c, p, m.channelId);
        const poll = (
          await c.query<{ options: { id: string }[]; multi: boolean; closed_at: Date | null }>("SELECT options, multi, closed_at FROM polls WHERE message_id = $1", [id])
        ).rows[0];
        if (!poll) throw new NotFound("poll not found");
        if (poll.closed_at) throw new Invalid("this poll is closed");
        const valid = new Set(poll.options.map((o) => o.id));
        const picked = [...new Set(b.optionIds)].filter((o) => valid.has(o));
        if (!poll.multi && picked.length > 1) throw new Invalid("pick one option");
        await c.query("DELETE FROM poll_votes WHERE message_id = $1 AND user_id = $2", [id, p.id]);
        for (const o of picked) await c.query("INSERT INTO poll_votes (message_id, option_id, user_id) VALUES ($1,$2,$3)", [id, o, p.id]);
        return loadMessage(c, id, p.id);
      }),
    );
    // Everyone sees the new counts; "mine" stays per person (each client keeps its own).
    const poll = (out as { poll?: { votes: { option: string; count: number }[]; voters: number } }).poll;
    if (poll)
      this.rt.toChannel(out.channelId, "poll.updated", {
        messageId: id,
        channelId: out.channelId,
        votes: poll.votes.map((v) => ({ option: v.option, count: v.count })),
        voters: poll.voters,
      });
    return out;
  }
}
