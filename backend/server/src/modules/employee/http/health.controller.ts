import { Controller, Get } from "@nestjs/common";

import { EmployeeControllerBase } from "./base.controller.js";

/** Liveness probe. */
@Controller()
export class HealthController extends EmployeeControllerBase {
  @Get("health")
  health() {
    return { ok: true };
  }
}
