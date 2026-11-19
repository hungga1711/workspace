import type { Tool } from "./tools.js";
import type { Say, Write } from "./workspace-kit.js";
import * as assist from "./tools-assist.js";
import * as chat from "./tools-chat.js";
import * as content from "./tools-content.js";
import * as office from "./tools-office.js";
import * as people from "./tools-people.js";
import * as reports from "./tools-reports.js";
import * as tasks from "./tools-tasks.js";
import * as web from "./tools-web.js";

/** The workspace tools beyond the first set, one file per area; workspace-tools.ts registers them beside its own. */
const AREAS = [tasks, chat, reports, content, people, assist, web, office];
export const EXTRA_READ: Tool[] = AREAS.flatMap((a) => a.READ);
export const EXTRA_WRITE: Write[] = AREAS.flatMap((a) => a.WRITE);
export const EXTRA_TITLES: Record<string, Say> = Object.assign({}, ...AREAS.map((a) => a.TITLES));
