/**
 * What the assistant sends back wherever it is asked: Hỏi đáp (ai/assistant/messages), a chat channel or a task
 * comment (ai/mention). One shape, so the three surfaces draw an answer, what it read and what it wants to do alike.
 */

/** A tool the answer used: never its arguments or result, only what ran and how it went. */
export interface ToolChip {
  /** "workspace" for the app's own tools (search, read, create a task…), else the outside system's id. */
  serverId: string;
  server: string;
  tool: string;
  /** For workspace tools already a readable sentence ("Search the workspace"). */
  title: string | null;
  outcome: "ok" | "error" | "timeout" | "denied" | "declined" | "auth";
  ms: number;
}

/** Something the answer read: opens the item in the app, or (`web`) the outside page in a new tab. */
export interface Source {
  type: "message" | "task" | "document" | "project" | "employee" | "meeting" | "event" | "file" | "approval" | "workflow" | "channel" | "web";
  id: string;
  title: string;
  url: string;
}

/** A change waiting for the person's yes. `preview` (workspace tools) says it in plain words; `args` is the raw detail. */
export interface PendingCard {
  id: string;
  serverId: string;
  server: string;
  tool: string;
  title: string | null;
  args: string;
  preview?: { title: string; fields: { label: string; value: string; md?: boolean }[]; note?: string };
}

/** What a question can point at: with @, or (the ask panel) the screen it is on and what is dragged or pasted in. `file` is a Drive item. */
export type RefKind = "task" | "document" | "project" | "meeting" | "workflow" | "file" | "channel" | "message" | "person" | "report";

/** POST ai/mention, and the answer to POST ai/assistant/pending/:id for a mention. */
export interface MentionAnswer {
  answer: string;
  model: string;
  toolCalls?: ToolChip[];
  sources?: Source[];
  /** Charts and tables of what its tools read (a channel answer only); checked by readBlocks before drawing. */
  blocks?: unknown;
  /** What the reader should know about how it was answered (progress.ts), and the questions worth asking next. */
  notes?: string[];
  followUps?: string[];
  pending?: PendingCard;
  /** Task comments: the AI's answer was posted on the task as this comment. */
  posted?: { commentId: string };
  conversationId?: string | null;
}

export const WORKSPACE_SERVER = "workspace";
