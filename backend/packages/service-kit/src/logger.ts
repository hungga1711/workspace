import { pino } from "pino";
import { currentRequestId, maybeRequestContext } from "@workspace/shared";

/** Structured logger: every line carries request and actor when bound. */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: process.env.SERVICE_NAME ?? "unknown" },
  mixin() {
    const out: Record<string, string> = {};
    const requestId = currentRequestId();
    if (requestId) out.requestId = requestId;
    const actorId = maybeRequestContext()?.actorId;
    if (actorId) out.actorId = actorId;
    return out;
  },
});
