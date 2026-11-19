import type { T } from "@/lib/i18n/core";

/** Built-in roles keep their English names in the API (seeded at setup); people see them in their language. */
const SYSTEM = { Owner: "admin.roleNames.Owner", Admin: "admin.roleNames.Admin", Manager: "admin.roleNames.Manager", Employee: "admin.roleNames.Employee" } as const;

export function roleLabel(name: string, tx: T): string {
  return name in SYSTEM ? tx(SYSTEM[name as keyof typeof SYSTEM]) : name;
}
