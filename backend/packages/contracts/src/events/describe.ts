import { z } from "zod";

/** A readable type for the catalog: `string`, `string[]`, `{ fileId, name }[]`, `"a" | "b"`, `?` when optional. */
function describeType(t: z.ZodTypeAny): string {
  if (t instanceof z.ZodOptional) return `${describeType(t.unwrap())}?`;
  if (t instanceof z.ZodNullable) return `${describeType(t.unwrap())} \\| null`;
  if (t instanceof z.ZodEffects) return describeType(t.innerType());
  if (t instanceof z.ZodUnion) {
    const opts = (t.options as z.ZodTypeAny[]).map(describeType);
    // A timestamp is produced as a Date or a string and always read as an ISO string.
    return opts.includes("date") ? "ISO string" : [...new Set(opts)].join(" \\| ");
  }
  if (t instanceof z.ZodString) return "string";
  if (t instanceof z.ZodNumber) return t.isInt ? "int" : "number";
  if (t instanceof z.ZodBoolean) return "boolean";
  if (t instanceof z.ZodDate) return "date";
  if (t instanceof z.ZodEnum) return (t.options as string[]).map((o) => `"${o}"`).join(" \\| ");
  if (t instanceof z.ZodArray) return `${describeType(t.element)}[]`;
  if (t instanceof z.ZodRecord) return "object";
  if (t instanceof z.ZodObject) return `{ ${Object.keys(t.shape as object).join(", ")} }`;
  return "any";
}

/** One line per top-level payload field: `name: type`. */
export function describePayload(schema: z.ZodTypeAny): string[] {
  if (!(schema instanceof z.ZodObject)) return [describeType(schema)];
  return Object.entries(schema.shape as Record<string, z.ZodTypeAny>).map(([k, v]) => {
    const d = describeType(v);
    return d.endsWith("?") ? `${k}?: ${d.slice(0, -1)}` : `${k}: ${d}`;
  });
}
