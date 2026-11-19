import { z } from "zod";
import { defineEvent, id, ids, timestamp } from "./define.js";

const channelKind = z.enum(["public", "private", "dm", "group"]);

export const chatEvents = {
  "chat.channel.created.v1": defineEvent({
    aggregateType: "chat.channel",
    summary: "A conversation was created: channel, DM, group, starter channel or import",
    intent: "projection",
    payload: z.object({ channelId: id, kind: channelKind, name: z.string().nullable(), topic: z.string().nullish(), memberIds: ids }),
  }),
  "chat.channel.updated.v1": defineEvent({
    aggregateType: "chat.channel",
    summary: "A channel was renamed, its topic changed, or it was archived",
    intent: "projection",
    payload: z.object({
      channelId: id,
      kind: channelKind,
      name: z.string().nullable(),
      topic: z.string().nullish(),
      archived: z.boolean(),
      previousName: z.string().nullable(),
    }),
  }),
  "chat.channel.member_added.v1": defineEvent({
    aggregateType: "chat.channel",
    summary: "People joined a channel (live sockets join synchronously; this is the record)",
    intent: "audit",
    payload: z.object({ channelId: id, userIds: ids }),
  }),
  "chat.channel.member_removed.v1": defineEvent({
    aggregateType: "chat.channel",
    summary: "Someone left or was removed from a channel",
    intent: "audit",
    payload: z.object({ channelId: id, userId: id }),
  }),
  "chat.message.created.v1": defineEvent({
    aggregateType: "chat.message",
    summary: "A message was posted (by a person, an agent, a scheduled send or the system)",
    intent: "projection",
    payload: z.object({
      messageId: id,
      channelId: id,
      channelKind,
      channelName: z.string().nullable(),
      seq: z.number().int(),
      threadRootId: z.string().nullable(),
      authorId: id,
      /** "import" only for history brought in from Slack (never published live, but the search feed carries it). */
      authorType: z.enum(["user", "agent", "system", "import"]),
      body: z.string(),
      mentions: z.array(z.string()),
      attachments: z.array(z.object({ fileId: id, name: z.string(), contentType: z.string(), size: z.number() })),
      /** DM and group members other than the author: "unanswered messages" on Home. */
      recipients: ids,
      /** Members who muted the conversation. */
      quiet: ids,
      /** Channel members who want a notice for every message. */
      everyMessage: ids,
    }),
  }),
  "chat.message.updated.v1": defineEvent({
    aggregateType: "chat.message",
    summary: "A message was edited, or imported history was written",
    intent: "projection",
    payload: z.object({ messageId: id, channelId: id, body: z.string(), channelKind: channelKind.optional(), channelName: z.string().nullish() }),
  }),
  "chat.message.deleted.v1": defineEvent({
    aggregateType: "chat.message",
    summary: "A message was deleted",
    intent: "projection",
    payload: z.object({ messageId: id, channelId: id }),
  }),
  "chat.status.set.v1": defineEvent({
    aggregateType: "chat.user",
    summary: "Do-not-disturb was set or cleared (`dndUntil` null); Home holds pushes back meanwhile",
    intent: "projection",
    payload: z.object({ userId: id, dndUntil: timestamp.nullable() }),
  }),
};
