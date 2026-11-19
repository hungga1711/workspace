/** Hours an entry may stay open before it counts as a forgotten check-out (ATTENDANCE_MAX_SHIFT_HOURS, default 16). */
export function maxShiftHours(env: NodeJS.ProcessEnv = process.env): number {
  const h = Number(env.ATTENDANCE_MAX_SHIFT_HOURS);
  return Number.isFinite(h) && h >= 4 && h <= 24 ? h : 16;
}

/**
 * An open check-in older than a shift was a forgotten check-out. Age, not the calendar day, decides it: a night shift
 * that starts at 22:00 and ends at 06:00 crosses midnight in any time zone and is still a normal entry.
 */
export function isMissedCheckout(checkIn: Date, now: Date, maxHours = maxShiftHours()): boolean {
  return now.getTime() - checkIn.getTime() > maxHours * 3600_000;
}
