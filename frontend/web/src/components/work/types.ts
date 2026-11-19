export interface Task {
  id: string;
  code: string;
  title: string;
  description: string;
  ownerId: string;
  assigneeId: string | null;
  projectId: string | null;
  status: string;
  priority: string;
  dueAt: string | null;
  /** Gantt: when work starts. */
  startAt?: string | null;
  /** The agent workflow it is handed to (AI › Workflow). */
  workflowId?: string | null;
  labels: string[];
  customFields: Record<string, unknown>;
  parentId: string | null;
  source: { channelId: string; messageId: string } | null;
  blockedReason?: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  recurrence?: string | null;
  progress?: number | null;
  etaAt?: string | null;
  checkinAt?: string | null;
  atRisk?: boolean;
}
export interface Project {
  id: string;
  code: string;
  name: string;
  status: string;
  ownerId: string;
  dueAt: string | null;
  openTasks: number;
  overdueTasks: number;
  doneTasks?: number;
  totalTasks?: number;
  blockedTasks?: number;
  atRiskTasks?: number;
  /** The work module's health rule (lib/health.ts); `projectHealthOf` applies the same rule when it is absent. */
  health?: import("@/lib/health").Health;
  daysLeft?: number | null;
  people?: string[];
  mine?: boolean;
  lastActivityAt?: string | null;
  /** When the project was made: the left end of its bar on Tiến độ's timeline. */
  createdAt?: string;
  description?: string;
  /** With ?preview=1 (the projects page): the latest progress note and the work in flight. */
  latestUpdate?: { taskId: string; taskCode: string; authorId: string; at: string; text: string } | null;
  inFlight?: { id: string; code: string; title: string; status: string; assigneeId: string | null; dueAt: string | null }[];
  /** The pace (work/velocity.ts): done and added per week (8, oldest first), in flight and stuck now. */
  flow?: import("./Velocity").ProjectFlow | null;
  /** The latest weekly status update (Overview › Weekly status). */
  statusUpdate?: import("./ProjectStatus").ProjectUpdate | null;
}
export interface Doc {
  id: string;
  code: string;
  title: string;
  ownerId: string;
  visibility: string;
  version: number;
  updatedAt: string;
}
export interface CalEvent {
  id: string;
  /** A meeting's readable code (H-012, H-012-3 in a series); other entries have none. */
  code?: string | null;
  title: string;
  kind: string;
  startsAt: string;
  endsAt: string;
  location: string;
  organizerId: string;
  response: string;
  seriesId?: string | null;
  recurrence?: string | null;
}
export interface Approval {
  id: string;
  /** Readable code (YC-007). */
  code?: string | null;
  title: string;
  details: string;
  requesterId: string;
  approverId: string;
  status: string;
  createdAt: string;
  decidedAt: string | null;
  kind?: "purchase" | "payment" | "advance" | "trip" | "other";
  /** Money asked for, in `currency` (ISO 4217); null when the request is not about money. */
  amount?: number | null;
  currency?: string | null;
  fields?: Record<string, string>;
  templateId?: string | null;
}
export interface Decision {
  id: string;
  title: string;
  details: string;
  status: "proposed" | "decided" | "withdrawn";
  decidedBy: string | null;
  deciderId: string | null;
  proposedBy: string | null;
  projectId: string | null;
  source: { channelId: string; messageId: string } | null;
  createdAt: string;
  decidedAt: string | null;
}
export interface FieldDef {
  entity: string;
  key: string;
  label: string;
  type: string;
  options: string[];
  required: boolean;
}
