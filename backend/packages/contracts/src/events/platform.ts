import { z } from "zod";
import { defineEvent, id } from "./define.js";

export const platformEvents = {
  "platform.workspace.created.v1": defineEvent({
    aggregateType: "platform.workspace",
    summary: "The installation's workspace was created at first-run setup",
    intent: "projection",
    payload: z.object({
      name: z.string(),
      ownerUserId: id,
      ownerName: z.string(),
      teamType: z.string(),
      locale: z.enum(["en", "vi", "zh", "es"]).optional(),
      // IANA zone of the new workspace (Admin › Cài đặt changes it later through config_changed).
      timezone: z.string().optional(),
      // The AI switches chosen at setup (absent on events from before they existed: treated as on).
      ai: z.object({ assistant: z.boolean(), monitoring: z.boolean() }).optional(),
    }),
  }),
  "platform.workspace.config_changed.v1": defineEvent({
    aggregateType: "platform.workspace",
    summary: "Workspace settings changed (code formats, time zone, modules); `version` orders snapshots",
    intent: "projection",
    payload: z.object({
      version: z.number().int(),
      // The whole workspace config travels; consumers read the parts they project.
      config: z.object({ codeFormats: z.record(z.string()), timezone: z.string(), locale: z.string() }).passthrough(),
    }),
  }),
};
