/**
 * Work's HTTP surface, one controller per area. Order matters: Nest registers routes in this order, so a literal
 * path comes before a `:param` one that would also match it.
 */
import { ActivityController } from "./activity.controller.js";
import { ApprovalsController } from "./approvals.controller.js";
import { AttentionController } from "./attention.controller.js";
import { ApprovalsCountController } from "./approvals-count.controller.js";
import { CalendarController } from "./calendar.controller.js";
import { ContentToolsController } from "./content-tools.controller.js";
import { DocsController } from "./docs.controller.js";
import { DriveController } from "./drive.controller.js";
import { FollowUpController } from "./followup.controller.js";
import { FreeBusyController } from "./free-busy.controller.js";
import { HealthController } from "./health.controller.js";
import { IntegrationsController } from "./integrations.controller.js";
import { LinkTextController } from "./link-text.controller.js";
import { OfficeController } from "./office.controller.js";
import { MeAiController } from "./me-ai.controller.js";
import { MeetController } from "./meet.controller.js";
import { MeetingsController } from "./meetings.controller.js";
import { ProjectsController } from "./projects.controller.js";
import { RelatedController } from "./related.controller.js";
import { ReportsController } from "./reports.controller.js";
import { SearchController } from "./search.controller.js";
import { TaskActionsController } from "./task-actions.controller.js";
import { TaskSyncController } from "./task-sync.controller.js";
import { TaskToolsController } from "./task-tools.controller.js";
import { TasksController } from "./tasks.controller.js";
import { VelocityController } from "./velocity.controller.js";
import { WhiteboardsController } from "./whiteboards.controller.js";
import { WorkflowsController } from "./workflows.controller.js";

export const WORK_CONTROLLERS = [
  HealthController,
  AttentionController,
  ProjectsController,
  WorkflowsController,
  ContentToolsController,
  RelatedController,
  TaskActionsController,
  TaskSyncController,
  TaskToolsController,
  IntegrationsController,
  LinkTextController,
  OfficeController,
  TasksController,
  DocsController,
  WhiteboardsController,
  DriveController,
  FreeBusyController,
  CalendarController,
  ActivityController,
  SearchController,
  MeetingsController,
  ApprovalsCountController,
  ApprovalsController,
  FollowUpController,
  VelocityController,
  ReportsController,
  MeAiController,
  MeetController,
];
export { AI, AI_STEPS, CHAT, EMPLOYEE, HUB, MEET, POOL, STORAGE, TASK_SYNC, WORKFLOWS } from "./common.js";
