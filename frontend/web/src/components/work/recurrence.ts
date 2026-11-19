import type { T } from "@/lib/i18n/core";
/** Labels for recurring meetings (work module calendar recurrence rules). */
export const REPEAT = (tx: T): Record<string, string> => ({
  daily: tx("labels.repeat.daily"),
  weekdays: tx("labels.repeat.weekdays"),
  weekly: tx("labels.repeat.weekly"),
  biweekly: tx("labels.repeat.biweekly"),
  monthly: tx("labels.repeat.monthly"),
});
