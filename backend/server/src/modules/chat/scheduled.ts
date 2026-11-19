import type { Pool } from "pg";
import { currentRequestId, newId, runWithContext, withTransaction } from "@workspace/shared";
import { logger } from "@workspace/service-kit";
import { membership, postMessage, type MessageDto } from "./domain.js";

/**
 * "Gửi sau": posts scheduled messages whose time has come, as their author. Each is claimed first (sent_at), so it
 * is never posted twice; someone who left the conversation meanwhile has it dropped.
 */
export async function sendScheduled(pool: Pool, emit: (channelId: string, m: MessageDto) => void, limit = 500): Promise<number> {
  const rows = (await pool.query<{ id: string }>("SELECT id FROM scheduled_messages WHERE sent_at IS NULL AND send_at <= now() ORDER BY send_at LIMIT $1", [limit])).rows;
  let sent = 0;
  for (const r of rows) {
    try {
      const posted = await runWithContext({ actorId: "service:scheduled-messages", requestId: currentRequestId() ?? newId() }, () =>
        withTransaction(pool, async (c) => {
          const s = (
            await c.query<{ channel_id: string; author_id: string; body: string }>(
              "UPDATE scheduled_messages SET sent_at = now() WHERE id = $1 AND sent_at IS NULL RETURNING channel_id, author_id, body",
              [r.id],
            )
          ).rows[0];
          if (!s) return null;
          if (!(await membership(c, s.channel_id, s.author_id))) {
            await c.query("UPDATE scheduled_messages SET failed = 'not_a_member' WHERE id = $1", [r.id]);
            return null;
          }
          const out = await postMessage(c, {
            channelId: s.channel_id,
            body: s.body,
            clientMsgId: `sched-${r.id}`,
            threadRootId: null,
            attachments: [],
            author: { id: s.author_id, type: "user" },
          });
          return out.created ? out.message : null;
        }),
      );
      if (posted) {
        emit(posted.channelId, posted);
        sent++;
      }
    } catch (err) {
      logger.warn({ err, id: r.id }, "scheduled message failed");
    }
  }
  return sent;
}
