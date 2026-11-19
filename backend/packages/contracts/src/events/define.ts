import { z } from "zod";

/**
 * Building blocks for event payload schemas. Payloads are validated in their wire form (after a
 * JSON round trip), so a timestamp may be produced as a Date and is read back as an ISO string.
 * Objects are not strict: adding an optional field is a compatible change and keeps the version.
 */
export const id = z.string().min(1);
export const ids = z.array(id);
export const timestamp = z.union([z.string().min(1), z.date()]).transform((v) => (v instanceof Date ? v.toISOString() : v));
/**
 * A calendar day, `YYYY-MM-DD`. node-postgres reads a `date` column as local midnight, so a Date is
 * turned back into its local day (an ISO string would shift it a day back east of UTC).
 */
const pad = (n: number) => String(n).padStart(2, "0");
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const day = z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}/), z.date()]).transform((v) => (v instanceof Date ? localDay(v) : v.slice(0, 10)));

export interface EventDefinition<S extends z.ZodTypeAny = z.ZodTypeAny> {
  /** Topic suffix: the event travels on `workspace.<aggregateType>`. */
  aggregateType: string;
  /** One line for the catalog: what happened, in business terms. */
  summary: string;
  /**
   * Who is expected to read it. "audit" events are published for the record and for integrations (webhooks) and
   * may have no consumer in this repository.
   */
  intent: "projection" | "audit";
  payload: S;
}

export const defineEvent = <S extends z.ZodTypeAny>(d: EventDefinition<S>): EventDefinition<S> => d;
