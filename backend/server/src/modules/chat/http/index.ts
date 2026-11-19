/**
 * Chat's HTTP surface, one controller per area. Nest registers routes in this order; no two routes here
 * can match the same request, so the order between areas does not change behaviour.
 */
import { AgentController } from "./agent.controller.js";
import { AssistController } from "./assist.controller.js";
import { ChannelsController } from "./channels.controller.js";
import { ExportController } from "./export.controller.js";
import { FilesController } from "./files.controller.js";
import { HealthController } from "./health.controller.js";
import { ImportsController } from "./imports.controller.js";
import { InboxController } from "./inbox.controller.js";
import { MessagesController } from "./messages.controller.js";
import { SavedController } from "./saved.controller.js";
import { ScheduledController } from "./scheduled.controller.js";
import { SearchController } from "./search.controller.js";
import { StatsController } from "./stats.controller.js";
import { StatusController } from "./status.controller.js";

export const CHAT_CONTROLLERS = [
  HealthController,
  ChannelsController,
  ImportsController,
  MessagesController,
  ExportController,
  FilesController,
  InboxController,
  SavedController,
  StatusController,
  ScheduledController,
  StatsController,
  SearchController,
  AgentController,
  AssistController,
];
export { CFG, POOL, REALTIME, SEARCH, STORAGE, type ChatCfg } from "./common.js";
