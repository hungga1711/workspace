import { Controller, Get } from "@nestjs/common";

import { WorkControllerBase } from "./base.controller.js";

/** Liveness probe. */
@Controller()
export class HealthController extends WorkControllerBase {
  @Get("health")
  health() {
    return { ok: true };
  }
}
