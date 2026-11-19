import { z } from "zod";
import { defineEvent, id } from "./define.js";

/**
 * Actions for the audit trail that no domain event describes: sign-ins, exports, downloads, admin settings, reads of
 * the trail itself (ADR 0025). The platform module's `platform-audit` consumer turns this event, and the domain
 * events it maps, into rows of `platform.audit_trail`. Never put private content here (message or document text,
 * prompts, descriptions, passwords, tokens): the consumer's privacy filter drops such keys anyway.
 */
export const auditEvents = {
  "audit.entry.recorded.v1": defineEvent({
    aggregateType: "audit.entry",
    summary: "An action was recorded for the audit trail (sign-in, export, download, admin setting) where no domain event says it",
    intent: "audit",
    payload: z.object({
      /** `module.entity.verb`, e.g. "identity.auth.signed_in", "work.file.downloaded". */
      action: z.string().regex(/^[a-z]+(\.[a-z_]+){2,}$/),
      targetType: z.string().min(1).max(64),
      targetId: id,
      /** Readable name at the time (a code and title, an email, a channel name); never content. */
      targetLabel: z.string().max(300).nullish(),
      outcome: z.enum(["success", "failure", "denied"]).default("success"),
      /** Field → { from, to } for non-private scalar fields. */
      changes: z.record(z.unknown()).optional(),
      meta: z.record(z.unknown()).optional(),
      /** One entry per actor, action and target within this many minutes (repeated downloads of the same file). */
      coalesceMinutes: z.number().int().min(1).max(1440).optional(),
    }),
  }),
};
