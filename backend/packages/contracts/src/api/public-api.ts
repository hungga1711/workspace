import { z } from "zod";
import {
  approvalDecisionBody,
  approvalRequestBody,
  calendarEventCreateBody,
  calendarEventUpdateBody,
  calendarRespondBody,
  isoDateTime,
  runActivityQuery,
  runAnswerBody,
  runApproveBody,
  runReworkBody,
  runStartBody,
  taskCommentBody,
  taskCreateBody,
  taskLinkBody,
  taskPriority,
  taskStatus,
  taskUpdateBody,
} from "./work.js";

/**
 * The public HTTP API: the gateway routes an API key (or a signed-in session) may call, with their inputs. It is the
 * source of `docs/api/openapi.json` (`pnpm api:openapi`), and the MCP tools are built on the same operations, so an
 * agent and an integration see one API. Every route still goes through the gateway and the owning module, which
 * check permissions as for the web app; this table only describes them.
 */

/** The release the document describes; bump with the release (CHANGELOG.md). */
export const API_VERSION = "1.0.0";

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface ApiOperation {
  operationId: string;
  method: HttpMethod;
  /** Gateway path, OpenAPI style (`/api/work/tasks/{id}`). */
  path: string;
  tag: "Tasks" | "Projects" | "Workflows" | "Approvals" | "Calendar" | "Documents" | "Whiteboards" | "Chat" | "People" | "Home" | "Search" | "Team" | "AI Insights" | "Account";
  /** The success status when it is not 200 (201 for a create, 204 for an answer without a body). */
  status?: 201 | 204;
  summary: string;
  description?: string;
  /** Permission the caller needs (the owning module decides; listed for API key creators). */
  permission?: string;
  params?: z.AnyZodObject;
  query?: z.AnyZodObject;
  body?: z.ZodTypeAny;
  response: z.ZodTypeAny;
}

const id = z.string().min(1).max(40);
const idParam = z.object({ id });
/** Reads also take the record's code (`T-041`, `P-001`, `D-012`; any case) in place of its id. */
const refParam = z.object({ id: z.string().min(1).describe("The id, or the code as shown in the app (T-041, P-001, D-012…)") });

export const taskObject = z
  .object({
    id,
    code: z.string().describe("Human-readable key, e.g. WEB-42"),
    title: z.string(),
    description: z.string(),
    ownerId: z.string(),
    assigneeId: z.string().nullable(),
    projectId: z.string().nullable(),
    status: taskStatus,
    priority: taskPriority,
    dueAt: isoDateTime.nullable(),
    labels: z.array(z.string()),
    completedAt: isoDateTime.nullable(),
    blockedReason: z.string().nullable(),
    progress: z.number().int().describe("0–100, from progress check-ins"),
    version: z.number().int().describe("Send back as expectedVersion when updating"),
    atRisk: z.boolean(),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
  })
  .passthrough();

export const projectObject = z
  .object({
    id,
    code: z.string(),
    name: z.string(),
    status: z.enum(["active", "archived"]),
    ownerId: z.string(),
    dueAt: isoDateTime.nullable(),
    openTasks: z.number().int(),
    overdueTasks: z.number().int(),
    blockedTasks: z.number().int(),
    atRiskTasks: z.number().int(),
    doneTasks: z.number().int(),
    totalTasks: z.number().int(),
    health: z.string().describe("not_started | on_track | at_risk | behind | done, the same rule as the web app"),
    daysLeft: z.number().int().nullable(),
  })
  .passthrough();

const loose = (description: string) => z.object({}).passthrough().describe(description);

/** A run of a task's agent workflow, as the task's list and `GET /api/work/runs/{id}` give it. */
export const runObject = z
  .object({
    id,
    taskId: id,
    workflowId: id.nullable(),
    workflowName: z.string(),
    runner: z.enum(["server", "local"]).describe("server: the company's AI; local: a connected computer"),
    status: z.enum(["queued", "running", "waiting_approval", "waiting_input", "paused", "done", "failed", "cancelled"]),
    currentStep: z.number().int(),
    steps: z.array(loose("Step: key, title, kind (ai | command | check | approval | status), state, input, output, startedAt, finishedAt, verdict, history")),
    error: z.string().nullable(),
    startedBy: z.string(),
    createdAt: isoDateTime,
    finishedAt: isoDateTime.nullable(),
    inputs: z.record(z.string()),
    usage: loose("inputTokens, outputTokens, workMs"),
    asks: z.array(loose("A round of questions: id, stepIndex, questions [{ id, text, kind, options }], answers, closedAt")).optional(),
    canApprove: z.boolean().optional(),
    canAnswer: z.boolean().optional(),
    canControl: z.boolean().optional(),
  })
  .passthrough();

/** "Cập nhật tiến độ" on a task: percent done, when it should be finished, and a note (whoever assigned it is told). */
export const taskCheckInBody = z.object({
  progress: z.number().int().min(0).max(100),
  etaAt: isoDateTime.nullable().default(null).describe("When it should be finished, if that changed"),
  note: z.string().max(2000).default(""),
});

/** A new document page: private to its creator unless placed in a space, a project or shared with the workspace. */
export const docCreateBody = z.object({
  title: z.string().trim().min(1).max(300),
  content: z.string().max(500_000).default(""),
  projectId: z.string().nullable().default(null),
  // Omitted: a page in a space follows the space; anything else is private to its owner.
  visibility: z.enum(["private", "project", "workspace", "space"]).optional(),
  spaceId: z.string().nullable().optional(),
  parentId: z.string().nullable().optional(),
  format: z.enum(["markdown", "html"]).optional().describe("markdown (default for API callers) or html"),
  labels: z.array(z.string().max(40)).max(20).optional(),
  emoji: z.string().max(16).optional(),
});

/** A chat message: text (Markdown), optionally as a reply in a thread. */
export const messagePostBody = z.object({
  body: z.string().trim().min(1).max(20000),
  threadRootId: z.string().length(26).nullable().default(null).describe("The thread's first message, to reply in its thread"),
  clientMsgId: z.string().min(8).max(64).nullable().default(null).describe("Your id for the message: a retry with the same id posts once"),
});

export const PUBLIC_API: ApiOperation[] = [
  {
    operationId: "getMe",
    method: "GET",
    path: "/api/me",
    tag: "Account",
    summary: "Who the credential acts as",
    description: "The principal behind the token or API key: its id, workspace and grants.",
    response: z.object({ principal: loose("Principal: type, id, grants") }),
  },
  {
    operationId: "listMyTasks",
    method: "GET",
    path: "/api/work/tasks",
    tag: "Tasks",
    summary: "My tasks, or one project's tasks",
    description:
      "Without `projectId`: tasks assigned to the caller plus their own unassigned to-dos (`scope=owned`: tasks they own), 50 per page, by due date. With `projectId`: that project's top-level tasks the caller may read, 200 per page. Needs a person (a personal API key), except with `projectId`.",
    permission: "task.read",
    query: z.object({
      scope: z.enum(["assigned", "owned"]).optional(),
      status: taskStatus.optional(),
      projectId: id.optional(),
      cursor: z.string().max(80).optional().describe("nextCursor of the previous page"),
    }),
    response: z.object({ tasks: z.array(taskObject), nextCursor: z.string().nullable() }),
  },
  {
    operationId: "getTask",
    method: "GET",
    path: "/api/work/tasks/{id}",
    tag: "Tasks",
    summary: "A task with its comments, subtasks, files and dependencies",
    permission: "task.read",
    params: refParam,
    response: z.object({ task: taskObject }).passthrough(),
  },
  {
    operationId: "createTask",
    method: "POST",
    path: "/api/work/tasks",
    tag: "Tasks",
    summary: "Create a task",
    permission: "task.create",
    body: taskCreateBody,
    response: taskObject,
  },
  {
    operationId: "updateTask",
    method: "PATCH",
    path: "/api/work/tasks/{id}",
    tag: "Tasks",
    summary: "Update a task",
    description: "Send only the fields to change, with `expectedVersion` = the task's current `version`; a stale version answers 409.",
    permission: "task.edit",
    params: idParam,
    body: taskUpdateBody,
    response: taskObject,
  },
  {
    operationId: "addTaskComment",
    method: "POST",
    path: "/api/work/tasks/{id}/comments",
    tag: "Tasks",
    summary: "Comment on a task",
    permission: "task.read",
    params: idParam,
    body: taskCommentBody,
    response: loose("The comment"),
  },
  {
    operationId: "editTaskComment",
    method: "PATCH",
    path: "/api/work/tasks/{id}/comments/{commentId}",
    tag: "Tasks",
    summary: "Edit your own comment",
    description: "Only the author. People mentioned for the first time are notified; `editedAt` is set.",
    permission: "task.read",
    params: z.object({ id, commentId: id }),
    body: taskCommentBody,
    response: loose("The comment: id, authorId, body, createdAt, editedAt"),
  },
  {
    operationId: "deleteTaskComment",
    method: "DELETE",
    path: "/api/work/tasks/{id}/comments/{commentId}",
    tag: "Tasks",
    summary: "Delete a comment",
    description: "The author, or anyone allowed to delete the task. The text is removed; the task history notes the deletion.",
    permission: "task.read",
    params: z.object({ id, commentId: id }),
    response: loose("Empty (204)"),
  },
  {
    operationId: "listTaskLinks",
    method: "GET",
    path: "/api/work/tasks/{id}/links",
    tag: "Tasks",
    summary: "A task's linked work: pull and merge requests, issues, designs",
    description:
      "Live cards from the tools the company connected in Admin › Integrations (GitHub, GitLab, Figma…). Addresses in the task's description and comments are picked up. A card older than five minutes is read again from its tool first, so this call can take several seconds.",
    permission: "task.read",
    params: refParam,
    response: z
      .object({
        links: z.array(
          loose(
            "Each link: id, taskId, provider, providerName, url, kind (review | issue | design | generic), source (manual | found | scan), card (title, state, author, facts…; null until read), cardAt, error, connected",
          ),
        ),
        connected: z.array(loose("id, name")),
      })
      .passthrough(),
  },
  {
    operationId: "addTaskLink",
    method: "POST",
    path: "/api/work/tasks/{id}/links",
    tag: "Tasks",
    summary: "Link a pull or merge request, an issue or a design to a task",
    description:
      "The address must be one an integration knows (a GitHub or GitLab pull or merge request or issue, a Figma file…); anything else is refused. A link to a tool the company has not connected yet is kept and reads `connected: false` until it is.",
    permission: "task.read",
    params: refParam,
    body: taskLinkBody,
    response: loose("The link, with its card when it could be read"),
  },
  {
    operationId: "removeTaskLink",
    method: "DELETE",
    path: "/api/work/tasks/{id}/links/{linkId}",
    tag: "Tasks",
    summary: "Remove a link from a task",
    description: "A link that was found in the task's text stays removed.",
    permission: "task.read",
    params: z.object({ id, linkId: id }),
    response: loose("Empty (204)"),
  },
  {
    operationId: "logTaskProgress",
    method: "POST",
    path: "/api/work/tasks/{id}/checkin",
    tag: "Tasks",
    summary: "Report progress on a task",
    description: "Percent done, an expected finish and a note, as the assignee's progress check-in; whoever assigned the task is told.",
    permission: "task.edit",
    params: idParam,
    body: taskCheckInBody,
    response: taskObject,
  },
  {
    operationId: "mySummary",
    method: "GET",
    path: "/api/work/me/summary",
    tag: "Tasks",
    summary: "My open work and how my week is going",
    description: "Open tasks assigned to the caller (or their own unassigned to-dos) by due date, recently finished ones, and this week's numbers. Needs a person.",
    permission: "task.read",
    response: loose("{ open, recentlyDone, projects, stats: { doneToday, doneThisWeek, doneLastWeek, onTimeRate, inProgress, overdue } }"),
  },
  {
    operationId: "listProjects",
    method: "GET",
    path: "/api/work/projects",
    tag: "Projects",
    summary: "Projects with progress and health",
    permission: "project.read",
    query: z.object({ status: z.enum(["active", "archived"]).optional(), limit: z.coerce.number().int().min(1).max(200).optional() }),
    response: z.object({ projects: z.array(projectObject) }),
  },
  {
    operationId: "getProject",
    method: "GET",
    path: "/api/work/projects/{id}",
    tag: "Projects",
    summary: "A project and its recent history",
    permission: "project.read",
    params: refParam,
    response: loose("Project: id, code, name, description, ownerId, teamId, status, dueAt, version, history"),
  },
  {
    operationId: "listProjectReviews",
    method: "GET",
    path: "/api/work/projects/{id}/reviews",
    tag: "Projects",
    summary: "A project's pull and merge requests, by the tasks they are linked to",
    description: "Open ones first. Only reviews on tasks the caller may read; cards are as last read (open the task's links to refresh one).",
    permission: "project.read",
    params: refParam,
    response: z.object({ reviews: z.array(loose("A link (see the task's links) with task: id, code, title, status")) }),
  },
  // ---------- agent workflows and their runs ----------
  {
    operationId: "listWorkflows",
    method: "GET",
    path: "/api/work/workflows",
    tag: "Workflows",
    summary: "The workspace's agent workflows",
    description:
      "Each workflow with its steps and its config: `config.inputs` is what a run asks for when it starts, `config.environment.kind` where it runs (`assistant`: the company's AI; `sandbox` or `computer`: a connected computer must be online to take the run). Also the ready-made templates and the connected computers.",
    permission: "task.read",
    response: z.object({ workflows: z.array(loose("Workflow: id, name, description, category, runner, steps, config")) }).passthrough(),
  },
  {
    operationId: "setTaskWorkflow",
    method: "PUT",
    path: "/api/work/tasks/{id}/workflow",
    tag: "Workflows",
    summary: "Hand a task to a workflow (or take it off)",
    description: "A workflow set to start by itself starts a run at once (`run` in the answer).",
    permission: "task.edit",
    params: refParam,
    body: z.object({ workflowId: id.nullable() }),
    response: z.object({ workflowId: id.nullable(), run: runObject.nullable() }),
  },
  {
    operationId: "listTaskRuns",
    method: "GET",
    path: "/api/work/tasks/{id}/runs",
    tag: "Workflows",
    summary: "A task's runs, newest first (up to 20)",
    permission: "task.read",
    params: refParam,
    response: z.object({ runs: z.array(runObject) }),
  },
  {
    operationId: "startRun",
    method: "POST",
    path: "/api/work/tasks/{id}/runs",
    tag: "Workflows",
    status: 201,
    summary: "Start the task's workflow",
    description:
      "Runs the workflow the task is handed to, with the inputs it asks for. One run at a time per task (`400` while one is in progress). A workflow on the assignee's own computer only starts for the assignee.",
    permission: "task.edit",
    params: refParam,
    body: runStartBody,
    response: runObject,
  },
  {
    operationId: "getRun",
    method: "GET",
    path: "/api/work/runs/{id}",
    tag: "Workflows",
    summary: "One run: its steps, what it asked, and what the caller may do on it",
    description: "Poll this (or subscribe to the `work.run.*` webhooks) to follow a run. `doing` is the latest action of the step at work.",
    permission: "task.read",
    params: idParam,
    response: runObject,
  },
  {
    operationId: "runActivity",
    method: "GET",
    path: "/api/work/runs/{id}/activity",
    tag: "Workflows",
    summary: "What the agent did in one step, a line per action",
    description:
      "Kinds: `start` (an attempt begins), `say` (the agent's words), `tool` (an action and what it acts on), `result` / `error` (how it ended), `note`, `draft` (the answer as it is written). Without `after`: the latest 400 lines; with it: the lines since, which is how to follow a step at work. `more` says another page waits.",
    permission: "task.read",
    params: idParam,
    query: runActivityQuery,
    response: z.object({ events: z.array(loose("id, step, at, kind, tool, text, detail")), more: z.boolean() }),
  },
  {
    operationId: "approveRun",
    method: "POST",
    path: "/api/work/runs/{id}/approve",
    tag: "Workflows",
    summary: "Approve the step a run waits on",
    description: "For whoever the step names as its approver (`canApprove` on the run). The note goes to the next step.",
    params: idParam,
    body: runApproveBody,
    response: runObject,
  },
  {
    operationId: "reworkRun",
    method: "POST",
    path: "/api/work/runs/{id}/rework",
    tag: "Workflows",
    summary: "Send the result back instead of approving",
    description: "The AI step under review runs again with the note, and every step after it too.",
    params: idParam,
    body: runReworkBody,
    response: runObject,
  },
  {
    operationId: "answerRunQuestions",
    method: "POST",
    path: "/api/work/agent-questions/{id}/answer",
    tag: "Workflows",
    summary: "Answer the questions a run's AI step asked",
    description: "`id` is the open round's id (`asks[].id` on the run, where `closedAt` is null). Or `skip: true` to let the AI decide.",
    params: idParam,
    body: runAnswerBody,
    response: runObject,
  },
  {
    operationId: "cancelRun",
    method: "POST",
    path: "/api/work/runs/{id}/cancel",
    tag: "Workflows",
    summary: "Stop a run",
    description: "The starter, the assignee, or anyone who may edit the task. A run that already ended answers `409`.",
    params: idParam,
    response: runObject,
  },

  // ---------- requests for approval ----------
  {
    operationId: "listApprovals",
    method: "GET",
    path: "/api/work/approvals",
    tag: "Approvals",
    summary: "Requests waiting for my decision, or the ones I sent",
    description: "The newest 100. Without `role`: requests where the caller is the approver.",
    query: z.object({ role: z.enum(["approver", "requester"]).optional() }),
    response: z.object({ approvals: z.array(loose("id, code, title, details, requesterId, approverId, status, kind, amount, currency, fields, createdAt, decidedAt")) }),
  },
  {
    operationId: "getApproval",
    method: "GET",
    path: "/api/work/approvals/{id}",
    tag: "Approvals",
    summary: "One request with its discussion",
    description: "Its requester, its approver and workspace-level delegates only.",
    params: refParam,
    response: loose("Approval: the row, canDecide, canCancel, comments, history"),
  },
  {
    operationId: "createApproval",
    method: "POST",
    path: "/api/work/approvals",
    tag: "Approvals",
    status: 201,
    summary: "Send a request for approval",
    permission: "task.create",
    body: approvalRequestBody,
    response: loose("id, code"),
  },
  {
    operationId: "decideApproval",
    method: "POST",
    path: "/api/work/approvals/{id}/decision",
    tag: "Approvals",
    status: 204,
    summary: "Approve or reject a request",
    description: "The approver (or their delegate). A request already decided answers `409`.",
    params: idParam,
    body: approvalDecisionBody,
    response: z.null(),
  },

  // ---------- calendar and meetings ----------
  {
    operationId: "listCalendarEvents",
    method: "GET",
    path: "/api/work/calendar/events",
    tag: "Calendar",
    summary: "My calendar between two moments",
    description: "Meetings, deadlines and events the caller attends, with their answer to each. Up to 500, by start.",
    permission: "calendar.read",
    query: z.object({ from: isoDateTime, to: isoDateTime }),
    response: z.object({ events: z.array(loose("id, code, title, kind, startsAt, endsAt, organizerId, location, response, seriesId, recurrence")) }),
  },
  {
    operationId: "createCalendarEvent",
    method: "POST",
    path: "/api/work/calendar/events",
    tag: "Calendar",
    status: 201,
    summary: "Schedule a meeting, a deadline or an event",
    description: "Attendees are invited and notified as in the app. A recurrence makes a series.",
    permission: "calendar.edit",
    body: calendarEventCreateBody,
    response: loose("id, code (and seriesId for a series)"),
  },
  {
    operationId: "updateCalendarEvent",
    method: "PATCH",
    path: "/api/work/calendar/events/{id}",
    tag: "Calendar",
    summary: "Move or rename an event",
    description: "The organizer only.",
    params: idParam,
    body: calendarEventUpdateBody,
    response: loose("The event"),
  },
  {
    operationId: "respondToCalendarEvent",
    method: "POST",
    path: "/api/work/calendar/events/{id}/respond",
    tag: "Calendar",
    status: 204,
    summary: "Accept or decline an invitation",
    params: idParam,
    body: calendarRespondBody,
    response: z.null(),
  },
  {
    operationId: "listMeetings",
    method: "GET",
    path: "/api/work/meetings",
    tag: "Calendar",
    summary: "My meetings, upcoming or past, with whether they have notes",
    query: z.object({ when: z.enum(["upcoming", "past"]).optional() }),
    response: z.object({ meetings: z.array(loose("id, code, title, startsAt, endsAt, organizerId, location, response, attendeeIds, hasAgenda, hasNotes, actionItems")) }),
  },
  {
    operationId: "getMeeting",
    method: "GET",
    path: "/api/work/meetings/{id}",
    tag: "Calendar",
    summary: "A meeting with its agenda, minutes and action items",
    params: refParam,
    response: loose("Meeting: the event (agenda, notes, version), attendees, tasks made from it"),
  },
  {
    operationId: "listDocuments",
    method: "GET",
    path: "/api/work/docs",
    tag: "Documents",
    summary: "Documents the caller may read, most recently updated first",
    permission: "document.read",
    query: z.object({ label: z.string().max(40).optional() }),
    response: z.object({ documents: z.array(loose("id, code, title, ownerId, visibility, version, updatedAt, spaceId")) }),
  },
  {
    operationId: "getDocument",
    method: "GET",
    path: "/api/work/docs/{id}",
    tag: "Documents",
    summary: "A document with its content",
    permission: "document.read",
    params: refParam,
    query: z.object({ track: z.enum(["0"]).optional().describe("0 = do not count this read as a page view (a script or an agent reading for someone)") }),
    response: loose("Document"),
  },
  {
    operationId: "createDocument",
    method: "POST",
    path: "/api/work/docs",
    tag: "Documents",
    summary: "Create a document",
    permission: "document.create",
    body: docCreateBody,
    response: loose("The document: id, code, title, owner_id, visibility"),
  },
  {
    operationId: "listWhiteboards",
    method: "GET",
    path: "/api/work/whiteboards",
    tag: "Whiteboards",
    summary: "Whiteboards the caller may open",
    permission: "document.read",
    query: z.object({ scope: z.enum(["all", "mine", "project"]).optional(), projectId: id.optional(), q: z.string().max(200).optional() }),
    response: z.object({ whiteboards: z.array(loose("id, code, title, projectId, projectName, ownerId, updatedAt")) }),
  },
  {
    operationId: "whiteboardText",
    method: "GET",
    path: "/api/work/whiteboards/{id}/text",
    tag: "Whiteboards",
    summary: "The words on a whiteboard",
    description: "Sticky notes, labels and free text, for readers that cannot draw the board.",
    params: refParam,
    response: z.object({ id, code: z.string(), title: z.string(), stickies: z.array(z.string()), labels: z.array(z.string()), text: z.string() }).passthrough(),
  },
  {
    operationId: "listChannels",
    method: "GET",
    path: "/api/chat/channels",
    tag: "Chat",
    summary: "My channels and DMs, and public channels I could join",
    permission: "channel.read",
    response: z
      .object({
        channels: z.array(loose("id, kind, name, displayName, topic, unread, mentions, dmUserId, lastMessageAt")),
        browsable: z.array(loose("id, name, displayName, topic, memberCount")),
      })
      .passthrough(),
  },
  {
    operationId: "channelMessages",
    method: "GET",
    path: "/api/chat/channels/{id}/messages",
    tag: "Chat",
    summary: "A channel's messages, newest first",
    description: "Pass `before` = the previous page's `nextBefore` for older messages. Thread replies are read with the thread.",
    permission: "message.read",
    params: idParam,
    query: z.object({ before: z.string().max(20).optional(), limit: z.coerce.number().int().min(1).max(100).optional() }),
    response: z.object({ messages: z.array(loose("id, seq, authorId, body, replyCount, createdAt, editedAt")), nextBefore: z.union([z.number(), z.string()]).nullable() }),
  },
  {
    operationId: "messageThread",
    method: "GET",
    path: "/api/chat/messages/{id}/thread",
    tag: "Chat",
    summary: "A message's thread: the first message and its replies",
    permission: "message.read",
    params: idParam,
    response: loose("{ root, replies, links }"),
  },
  {
    operationId: "postMessage",
    method: "POST",
    path: "/api/chat/channels/{id}/messages",
    tag: "Chat",
    summary: "Post a message in a channel the caller belongs to",
    permission: "message.post",
    params: idParam,
    body: messagePostBody,
    response: loose("The message"),
  },
  {
    operationId: "listPeople",
    method: "GET",
    path: "/api/employee/employees",
    tag: "People",
    summary: "The company directory",
    description: "Public fields only (name, title, department, manager). Paged by name.",
    permission: "employee.profile.read",
    query: z.object({
      q: z.string().max(100).optional().describe("Part of a name"),
      after: z.string().max(200).optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
      all: z.enum(["1"]).optional().describe("1 = everyone in one answer (ids and names, for turning ids into names); not paged"),
    }),
    response: z.object({ employees: z.array(loose("userId, code, displayName, title, department, managerId")), nextCursor: z.string().nullable() }),
  },
  {
    operationId: "getPerson",
    method: "GET",
    path: "/api/employee/employees/{userId}",
    tag: "People",
    summary: "One person's profile",
    description: "Phone and hire date only for the person, their manager and admins.",
    permission: "employee.profile.read",
    params: z.object({ userId: id }),
    response: loose("userId, code, displayName, title, department, managerId, location"),
  },
  {
    operationId: "myDay",
    method: "GET",
    path: "/api/home/home",
    tag: "Home",
    summary: "My day: what needs me and what is on today",
    description: "Approvals, decisions, blockers, mentions and tasks waiting for the caller, today's meetings and deadlines, and counts.",
    permission: "home.read",
    response: loose("{ counts, needsYou, today, inboxActionCount, timezone }"),
  },
  {
    operationId: "notifications",
    method: "GET",
    path: "/api/home/notifications",
    tag: "Home",
    summary: "My inbox: notifications that need action, and updates",
    response: loose("{ action, updates, badge }"),
  },
  {
    operationId: "search",
    method: "GET",
    path: "/api/chat/search",
    tag: "Search",
    summary: "Search messages, channels, files, people, tasks, projects and documents",
    description: "Only what the caller may read; results are rechecked against the owning module.",
    permission: "message.read",
    query: z.object({
      q: z.string().min(2).max(200),
      types: z.string().max(80).optional().describe("Comma-separated: message, channel, file, person, task, project, document"),
    }),
    response: z.object({ hits: z.array(loose("A hit: type, id, title, snippet, url")) }),
  },
  {
    operationId: "teamStatus",
    method: "GET",
    path: "/api/work/followup/team",
    tag: "Team",
    summary: "Workload and status of the caller's people",
    description: "Admins see everyone, managers their reporting line or team: open, overdue, at-risk and blocked work per person and department.",
    permission: "task.read",
    query: z.object({ brief: z.enum(["1"]).optional().describe("1 = numbers and only the tasks worth asking about") }),
    response: loose("{ scope, totals, departments, people }"),
  },
  {
    operationId: "outcomes",
    method: "GET",
    path: "/api/work/followup/outcomes",
    tag: "Team",
    summary: "What the caller's people got done, with and without AI help",
    permission: "task.read",
    query: z.object({ days: z.enum(["7", "30", "90"]).optional() }),
    response: loose("Done, on time, median days, and withAi: { assisted, other }"),
  },
  {
    operationId: "lateTasks",
    method: "GET",
    path: "/api/work/task-tools/late",
    tag: "Team",
    summary: "Overdue and at-risk tasks the caller may read",
    permission: "task.read",
    query: z.object({ project: z.string().max(80).optional().describe("A project code or id") }),
    response: loose("{ tasks } with assignee, due date, overdue or at risk"),
  },
  {
    operationId: "blockedTasks",
    method: "GET",
    path: "/api/work/reports/blockers",
    tag: "Team",
    summary: "Blocked tasks, longest blocked first, with what each waits on",
    permission: "task.read",
    response: loose("{ tasks } with blocked since, reason, the chain of open tasks waited on, and how many wait on it"),
  },
  {
    operationId: "teamOutput",
    method: "GET",
    path: "/api/work/reports/output",
    tag: "Team",
    summary: "Tasks finished per person, this window and the one before",
    description: "Admins see everyone, managers their reporting line.",
    permission: "task.read",
    query: z.object({ days: z.enum(["7", "14", "30", "90"]).optional() }),
    response: loose("{ days, people } with done, done before and on-time rate"),
  },
  {
    operationId: "unansweredQuestions",
    method: "GET",
    path: "/api/chat/assist/unanswered",
    tag: "Chat",
    summary: "Questions put to the caller in chat that nobody answered",
    permission: "message.read",
    query: z.object({
      hours: z
        .string()
        .regex(/^\d{1,3}$/)
        .optional()
        .describe("Unanswered for at least this many hours (default 4)"),
      days: z
        .string()
        .regex(/^\d{1,2}$/)
        .optional()
        .describe("Looking back this many days (default 14)"),
      direct: z.enum(["1"]).optional().describe("1 = direct conversations only"),
    }),
    response: loose("{ questions } with who asked, where, when"),
  },
  {
    operationId: "attendanceSummary",
    method: "GET",
    path: "/api/employee/attendance/summary",
    tag: "People",
    summary: "Attendance per person for a period (up to 92 days)",
    description: "Days worked, hours, late arrivals, missed clock-outs, leave and absences; the same people the caller sees in Team today.",
    query: z.object({
      from: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
      to: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
      department: z.string().max(120).optional(),
      userId: z.string().max(40).optional(),
    }),
    response: loose("{ from, to, people }"),
  },
  {
    operationId: "aiInsights",
    method: "GET",
    path: "/api/ai/oversight",
    tag: "AI Insights",
    summary: "AI Insights aggregates for the caller's audience",
    description:
      "Counts per person, department, tool and topic; never conversation text. Admins see everyone, managers their reporting line. 404 `ai_off` when the company has not switched AI Insights on.",
    query: z.object({ days: z.enum(["7", "30", "90"]).optional() }),
    response: loose("{ totals, people, departments, features, policy }"),
  },
];
