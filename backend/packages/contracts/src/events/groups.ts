/**
 * Every consumer group and the topics (`workspace.<aggregateType>`) it reads. Events are delivered inside the
 * server process (service-kit EventBus); the server refuses to start unless every group listed here has
 * subscribed, so no group's events are marked delivered without it.
 *
 * consumeEvents refuses a listed group with a different topic set, so this table and the modules' own topic
 * constants cannot drift apart. Unlisted groups (tests, one-off tools) work without that guarantee.
 */
export const CONSUMER_GROUPS = {
  /** home: notifications, Home feed, briefs and the workspace time zone. */
  "home-projector": [
    "workspace.work.task",
    "workspace.work.run",
    "workspace.work.approval",
    "workspace.chat.message",
    "workspace.work.calendar",
    "workspace.ai.quota",
    "workspace.employee.leave",
    "workspace.work.decision",
    "workspace.work.document",
    "workspace.ai.agent",
    "workspace.identity.member",
    "workspace.ai.activity",
    "workspace.chat.user",
    "workspace.platform.workspace",
    "workspace.employee.announcement",
  ],
  /** platform: outbound webhooks (WEBHOOK_EVENTS). */
  "platform-webhooks": [
    "workspace.work.task",
    "workspace.work.project",
    "workspace.work.approval",
    "workspace.work.decision",
    "workspace.work.run",
    "workspace.employee.leave",
    "workspace.identity.member",
    "workspace.employee.announcement",
    "workspace.chat.channel",
  ],
  /**
   * platform: the audit trail (ADR 0025). Every topic with something an admin may need to trace; events without a
   * mapping (task check-ins, reminders…) are skipped without a database round trip. Chat messages are not read at
   * all: a moderator's deletion is recorded directly (`audit.entry`).
   */
  "platform-audit": [
    "workspace.audit.entry",
    "workspace.identity.member",
    "workspace.chat.channel",
    "workspace.work.task",
    "workspace.work.run",
    "workspace.work.project",
    "workspace.work.document",
    "workspace.work.whiteboard",
    "workspace.work.approval",
    "workspace.work.decision",
    "workspace.work.delegation",
    "workspace.work.calendar",
    "workspace.employee.leave",
    "workspace.employee.profile",
    "workspace.employee.holiday",
    "workspace.employee.attendance",
    "workspace.employee.announcement",
    "workspace.ai.activity",
    "workspace.ai.connection",
  ],
  /** employee: a profile for every member, the workspace time zone. */
  "employee-profiles": ["workspace.identity.member", "workspace.platform.workspace"],
  /** employee: approval delegations created in work. */
  "employee-delegations": ["workspace.work.delegation"],
  /** chat: welcome channels for a new workspace and member; disconnects disabled members. */
  "chat-onboarding": ["workspace.platform.workspace", "workspace.identity.member"],
  /** chat: link previews for posted and edited messages. */
  "chat-unfurl": ["workspace.chat.message"],
  /** work: the workspace's settings (code formats, time zone). */
  "work-settings": ["workspace.platform.workspace"],
  /** work: tasks the company AI helped with (ADR 0011). */
  "work-ai-assists": ["workspace.ai.usage"],
  /** ai: the workspace time zone. */
  "ai-settings": ["workspace.platform.workspace"],
  /** ai: a change anywhere clears the AI's recent tool results (tool-cache.ts), so an answer never reads from before it. */
  "ai-tool-cache": [
    "workspace.work.task",
    "workspace.work.project",
    "workspace.work.run",
    "workspace.work.approval",
    "workspace.work.calendar",
    "workspace.work.document",
    "workspace.work.knowledge",
    "workspace.chat.message",
    "workspace.chat.channel",
    "workspace.employee.leave",
    "workspace.employee.attendance",
    "workspace.employee.profile",
    "workspace.identity.member",
  ],
  /** search: the search index. */
  "search-indexer": [
    "workspace.chat.message",
    "workspace.chat.channel",
    "workspace.work.task",
    "workspace.work.project",
    "workspace.work.document",
    "workspace.work.whiteboard",
    "workspace.identity.member",
    // Passages for AI retrieval: comments, meetings, calendar entries, files and requests (search/indexer.ts).
    "workspace.work.knowledge",
    "workspace.work.calendar",
    "workspace.work.approval",
  ],
} as const satisfies Record<string, readonly string[]>;

export type ConsumerGroup = keyof typeof CONSUMER_GROUPS;

export const isConsumerGroup = (g: string): g is ConsumerGroup => Object.prototype.hasOwnProperty.call(CONSUMER_GROUPS, g);
