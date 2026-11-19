import { Controller, Get } from "@nestjs/common";

import { ChatControllerBase } from "./base.controller.js";

/** Liveness probe. */
@Controller()
export class HealthController extends ChatControllerBase {
  @Get("health")
  health() {
    return { ok: true };
  }
}
