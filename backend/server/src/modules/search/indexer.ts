import type { Pool, PoolClient } from "pg";
import type { EventEnvelope } from "@workspace/contracts";
import {
  consumeEvents,
  deleteDoc,
  deletePassages,
  indexDocs,
  indexPassages,
  setPassageAccess,
  type EventBus,
  type EventConsumer,
  type KnowledgeAccess,
  type KnowledgeDoc,
  type PassageType,
  type SearchDoc,
} from "@workspace/service-kit";
import { withTransaction } from "@workspace/shared";

/**
 *   owning module's outbox ─► event bus workspace.<domain>.<entity> ─► this consumer ─► the `search` schema
 *
 * Writes are keyed by (type, id), so redelivery is idempotent. Every document carries container_id, which
 * search filters on (ADR 0013).
 */
const INDEXED_TOPICS = [
  "workspace.chat.message",
  "workspace.chat.channel",
  "workspace.work.task",
  "workspace.work.project",
  "workspace.work.document",
  "workspace.work.whiteboard",
  "workspace.identity.member",
  "workspace.work.knowledge",
  "workspace.work.calendar",
  "workspace.work.approval",
];
/** Container for people: every member of a workspace can find every other member. */
const PEOPLE_CONTAINER = "people";

type P = Record<string, unknown>;
const s = (v: unknown) => (typeof v === "string" ? v : "");

/**
 * `index`/`delete`: search_documents, from the event itself (what the search box finds). `pull`: the thing's text
 * changed, its passages are rebuilt from what the work module says it is now (comments, minutes, a whole page do not
 * travel in events). `know`/`forget`: passages given with the event (the re-index feed) or gone.
 */
export type KnowledgeRef = { type: PassageType; id: string };
type Action =
  | { op: "index"; doc: SearchDoc }
  | { op: "delete"; type: SearchDoc["entity_type"]; id: string }
  | { op: "pull"; ref: KnowledgeRef }
  | { op: "know"; doc: KnowledgeDoc }
  | { op: "forget"; ref: KnowledgeRef };

/** Reads the current text of things from the module that owns them: what is still there, and what is gone. */
/** `access`: the readers of now for things whose text did not change (the files attached to a task or a page that did). */
export type FetchKnowledge = (items: KnowledgeRef[]) => Promise<{ docs: KnowledgeDoc[]; gone: KnowledgeRef[]; access?: KnowledgeAccess[] }>;

/** Kinds that exist only as knowledge: their search_documents row is written from the same text as their passages. */
const KNOWLEDGE_ONLY = new Set<string>(["meeting", "event", "approval", "file"]);

/** One event can produce several documents (a message and its attached files). */
export function toActions(e: EventEnvelope): Action[] {
  const main = toAction(e);
  const p = e.payload as P;
  const out: Action[] = [...(main ? [main] : []), ...knowledgeActions(e)];
  if (e.eventType === "chat.message.created.v1" && Array.isArray(p.attachments)) {
    for (const a of p.attachments as { fileId: string; name: string; contentType: string }[]) {
      out.push({
        op: "index",
        doc: {
          created_at: e.occurredAt,
          updated_at: e.occurredAt,
          entity_type: "file",
          entity_id: a.fileId,
          container_id: s(p.channelId),
          title: a.name,
          body: `${a.contentType} ${s(p.channelName) ? `#${s(p.channelName)}` : ""}`,
          url: `/app/chat/${s(p.channelId)}?m=${s(p.messageId)}`,
        },
      });
    }
  }
  return out;
}

/** What an event means for the passages. */
function knowledgeActions(e: EventEnvelope): Action[] {
  const p = e.payload as P;
  const pull = (type: PassageType, id: string): Action[] => (id ? [{ op: "pull", ref: { type, id } }] : []);
  switch (e.eventType) {
    case "work.task.created.v1":
    case "work.task.updated.v1":
    case "work.task.commented.v1":
    case "work.task.comment_edited.v1":
    case "work.task.comment_deleted.v1":
      return pull("task", s(p.taskId));
    case "work.task.deleted.v1":
      return [{ op: "forget", ref: { type: "task", id: s(p.taskId) } }];
    case "work.document.created.v1":
    case "work.document.updated.v1":
      return pull("document", s(p.documentId));
    case "work.document.deleted.v1":
      return [{ op: "forget", ref: { type: "document", id: s(p.documentId) } }];
    case "work.meeting.scheduled.v1":
    case "work.event.scheduled.v1":
      return pull(p.kind === "meeting" ? "meeting" : "event", s(p.eventId));
    case "work.event.cancelled.v1":
      // The event does not say which kind it was: both are forgotten.
      return [
        { op: "forget", ref: { type: "meeting", id: s(p.eventId) } },
        { op: "forget", ref: { type: "event", id: s(p.eventId) } },
      ];
    case "work.approval.requested.v1":
    case "work.approval.decided.v1":
    case "work.approval.commented.v1":
      return pull("approval", s(p.approvalId));
    case "work.knowledge.changed.v1": {
      const ref = { type: p.type as PassageType, id: s(p.id) };
      const d = p.doc as { containerId: string; aclUsers: string[]; title: string; text: string; url: string; updatedAt: string } | null | undefined;
      if (d === undefined) return [{ op: "pull", ref }];
      if (d === null) return [{ op: "forget", ref }];
      return [
        {
          op: "know",
          doc: { entity_type: ref.type, entity_id: ref.id, container_id: d.containerId, acl_users: d.aclUsers, title: d.title, body: d.text, url: d.url, updated_at: d.updatedAt },
        },
      ];
    }
    default:
      return [];
  }
}

/** Writes one thing's passages, and its search_documents row when it has no other source. */
export async function know(c: PoolClient, doc: KnowledgeDoc): Promise<void> {
  await indexPassages(c, doc);
  if (KNOWLEDGE_ONLY.has(doc.entity_type))
    await indexDocs(c, [
      {
        entity_type: doc.entity_type,
        entity_id: doc.entity_id,
        container_id: doc.container_id,
        acl_users: doc.acl_users,
        title: doc.title,
        body: doc.body.slice(0, 200_000),
        url: doc.url,
        created_at: doc.updated_at,
        updated_at: doc.updated_at,
      },
    ]);
}

export async function forget(c: PoolClient, ref: KnowledgeRef): Promise<void> {
  await deletePassages(c, ref.type, ref.id);
  if (KNOWLEDGE_ONLY.has(ref.type)) await deleteDoc(c, ref.type, ref.id);
}

export function toAction(e: EventEnvelope): Action | null {
  const p = e.payload as P;
  const base = { created_at: e.occurredAt, updated_at: e.occurredAt };
  switch (e.eventType) {
    case "chat.message.created.v1":
    case "chat.message.updated.v1":
      return {
        op: "index",
        doc: {
          ...base,
          entity_type: "message",
          entity_id: s(p.messageId),
          container_id: s(p.channelId),
          title: s(p.channelName),
          body: s(p.body),
          url: `/app/chat/${s(p.channelId)}?m=${s(p.messageId)}`,
        },
      };
    case "chat.channel.created.v1":
    case "chat.channel.updated.v1":
      // Public and private channels are findable by name (renames re-index); DMs and groups are not.
      if (p.kind !== "public" && p.kind !== "private") return null;
      return {
        op: "index",
        doc: {
          ...base,
          entity_type: "channel",
          entity_id: s(p.channelId),
          container_id: s(p.channelId),
          title: `#${s(p.name)}`,
          body: s(p.topic),
          url: `/app/chat/${s(p.channelId)}`,
        },
      };
    case "identity.member.joined.v1":
    case "identity.member.renamed.v1":
      if (!s(p.displayName)) return null;
      return {
        op: "index",
        doc: {
          ...base,
          entity_type: "person",
          entity_id: s(p.userId),
          container_id: PEOPLE_CONTAINER,
          title: s(p.displayName),
          body: s(p.email),
          url: `/app/me/people?u=${s(p.userId)}`,
        },
      };
    case "chat.message.deleted.v1":
      return { op: "delete", type: "message", id: s(p.messageId) };
    case "work.task.created.v1":
    case "work.task.updated.v1":
      return {
        op: "index",
        doc: {
          ...base,
          entity_type: "task",
          entity_id: s(p.taskId),
          container_id: s(p.projectId) || `user:${s(p.ownerId)}`,
          acl_users: [s(p.ownerId), s(p.assigneeId)].filter(Boolean),
          title: `${s(p.code)} ${s(p.title)}`,
          body: s(p.description),
          url: `/app/work/tasks/${s(p.taskId)}`,
        },
      };
    case "work.task.deleted.v1":
      return { op: "delete", type: "task", id: s(p.taskId) };
    case "work.project.created.v1":
    case "work.project.updated.v1":
      return {
        op: "index",
        doc: {
          ...base,
          entity_type: "project",
          entity_id: s(p.projectId),
          container_id: s(p.projectId),
          title: `${s(p.code)} ${s(p.name)}`,
          body: s(p.description),
          url: `/app/work/projects/${s(p.projectId)}`,
        },
      };
    case "work.document.created.v1":
    case "work.document.updated.v1":
      return {
        op: "index",
        doc: {
          ...base,
          entity_type: "document",
          entity_id: s(p.documentId),
          container_id: s(p.projectId) || `doc:${s(p.documentId)}`,
          acl_users: (p.sharedWith as string[] | undefined) ?? [],
          title: s(p.title),
          body: s(p.text),
          url: `/app/work/docs/${s(p.documentId)}`,
        },
      };
    case "work.document.deleted.v1":
      return { op: "delete", type: "document", id: s(p.documentId) };
    case "work.whiteboard.created.v1":
    case "work.whiteboard.updated.v1":
      // Like a page: "workspace" or the project as container; a private board only for its owner.
      return {
        op: "index",
        doc: {
          ...base,
          entity_type: "whiteboard",
          entity_id: s(p.whiteboardId),
          container_id: s(p.projectId) || `wb:${s(p.whiteboardId)}`,
          acl_users: [s(p.ownerId)].filter(Boolean),
          title: `${s(p.code)} ${s(p.title)}`,
          body: s(p.text),
          url: `/app/work/whiteboards/${s(p.whiteboardId)}`,
        },
      };
    case "work.whiteboard.deleted.v1":
      return { op: "delete", type: "whiteboard", id: s(p.whiteboardId) };
    default:
      return null;
  }
}

/**
 * Applies one event's index actions. Idempotent: documents and passages are keyed by entity id, so a redelivered
 * event rewrites the same rows (no processed_events ledger needed). Passages are read from the owning module as it
 * is now, so events arriving out of order end in the same index. Without `fetch` (a tool that only has the events)
 * the pulls are skipped.
 */
async function applyActions(c: PoolClient, e: EventEnvelope, fetch?: FetchKnowledge): Promise<number> {
  const actions = toActions(e);
  await indexDocs(
    c,
    actions.flatMap((a) => (a.op === "index" ? [a.doc] : [])),
  );
  for (const a of actions) {
    if (a.op === "delete") await deleteDoc(c, a.type, a.id);
    else if (a.op === "know") await know(c, a.doc);
    else if (a.op === "forget") await forget(c, a.ref);
  }
  const pulls = actions.flatMap((a) => (a.op === "pull" ? [a.ref] : []));
  if (pulls.length && fetch) {
    const r = await fetch(pulls);
    for (const doc of r.docs) await know(c, doc);
    for (const ref of r.gone) await forget(c, ref);
    for (const a of r.access ?? []) await setPassageAccess(c, a);
  }
  return actions.length;
}

/**
 * The shared consumer loop (service-kit consumeEvents): payloads validated against @workspace/contracts,
 * retries with backoff, then dead letters, so a failing write never blocks the other events. Each event is applied in one
 * transaction.
 */
export async function startIndexer(bus: EventBus, pool: Pool, groupId = "search-indexer", fetch?: FetchKnowledge): Promise<EventConsumer> {
  // Dead letters land in the search schema's dead_events, like every other consumer's.
  return consumeEvents({
    bus,
    groupId,
    topics: [...INDEXED_TOPICS],
    deadLetters: pool,
    handle: (e) => withTransaction(pool, (c) => applyActions(c, e, fetch)).then(() => undefined),
  });
}
