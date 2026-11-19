import type { PoolClient } from "pg";
import { Invalid } from "./errors.js";

interface FieldDef {
  key: string;
  label: string;
  type: "text" | "number" | "date" | "select" | "boolean";
  options: string[];
  required: boolean;
}

/** Validates custom field values against the workspace's definitions. Unknown keys are rejected. */
export async function validateCustomFields(c: PoolClient, entity: "task" | "project", values: Record<string, unknown>, partial: boolean): Promise<void> {
  const defs = (await c.query<FieldDef>("SELECT key, label, type, options, required FROM custom_field_defs WHERE entity = $1", [entity])).rows;
  const byKey = new Map(defs.map((d) => [d.key, d]));
  for (const [k, v] of Object.entries(values)) {
    const d = byKey.get(k);
    if (!d) throw new Invalid(`unknown custom field ${k}`);
    if (v === null) continue;
    const ok =
      (d.type === "text" && typeof v === "string" && v.length <= 2000) ||
      (d.type === "number" && typeof v === "number" && Number.isFinite(v)) ||
      (d.type === "boolean" && typeof v === "boolean") ||
      (d.type === "date" && typeof v === "string" && !Number.isNaN(Date.parse(v))) ||
      (d.type === "select" && typeof v === "string" && d.options.includes(v));
    if (!ok) throw new Invalid(`invalid value for ${d.label}`);
  }
  if (!partial) {
    for (const d of defs) if (d.required && (values[d.key] === undefined || values[d.key] === null)) throw new Invalid(`${d.label} is required`);
  }
}
