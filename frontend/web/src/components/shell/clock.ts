/** What check-in / check-out answer: the entry, plus the day of a forgotten check-out the server just closed. */
export interface ClockResult {
  day: string;
  checkIn: string;
  missedCheckout?: boolean;
  closedMissed?: { day: string };
}

/** The day whose forgotten check-out was closed with no hours (null: nothing to fix). */
export function missedDay(r: ClockResult | null | undefined): string | null {
  return r?.closedMissed?.day ?? (r?.missedCheckout ? r.day : null);
}

/** Chấm công with the correction form open on that day. */
export const fixHref = (day: string) => `/app/time?fix=${day}`;
