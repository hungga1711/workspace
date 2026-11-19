/**
 * Paging for DateField's month and year views. Years page by twelve, aligned so a decade starts the second cell
 * (2019 · 2020…2029 · 2030): this decade, with a neighbour on each side to step into.
 */
export const yearPageStart = (year: number) => Math.floor(year / 10) * 10 - 1;
export const yearPage = (year: number) => Array.from({ length: 12 }, (_, i) => yearPageStart(year) + i);

/** A "YYYY-MM-DD" that names a real day (a URL's ?date=), else null. */
export function dayParam(v: string | null | undefined): string | null {
  const m = v ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(v) : null;
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() >= 1900 && d.toISOString().slice(0, 10) === v ? v : null;
}
