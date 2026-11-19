import { z } from "zod";
import { defineEvent } from "./define.js";

export const opsEvents = {
  "ops.probe.sent.v1": defineEvent({
    aggregateType: "ops.probe",
    summary: "A pipeline probe (outbox → relay → event bus → consumer) written by tests and health checks; nobody acts on it",
    intent: "audit",
    payload: z.object({ n: z.number().optional() }).passthrough(),
  }),
};
