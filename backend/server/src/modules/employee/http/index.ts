/**
 * Employee's HTTP surface, one controller per area, registered after PeopleController and before
 * AnnouncementsController (app.ts): Nest matches routes in registration order.
 */
import { AttendanceController } from "./attendance.controller.js";
import { AvailabilityController } from "./availability.controller.js";
import { CompensationController } from "./compensation.controller.js";
import { DepartmentsController } from "./departments.controller.js";
import { HandoverController } from "./handover.controller.js";
import { HealthController } from "./health.controller.js";
import { HolidaysController } from "./holidays.controller.js";
import { LeaveCountController } from "./leave-count.controller.js";
import { LeaveController } from "./leave.controller.js";
import { ProfilesController } from "./profiles.controller.js";
import { SettingsController } from "./settings.controller.js";

export const EMPLOYEE_CONTROLLERS = [
  HealthController,
  ProfilesController,
  HandoverController,
  HolidaysController,
  DepartmentsController,
  CompensationController,
  AvailabilityController,
  AttendanceController,
  LeaveCountController,
  LeaveController,
  SettingsController,
];
export { POOL } from "./common.js";
