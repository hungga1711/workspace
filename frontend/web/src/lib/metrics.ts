/*
 * Rules that keep the numbers on Tiến độ honest (pure, unit-tested in metrics.test.ts):
 * a missing value is "chưa có", never 0% next to 0 items; a comparison needs enough tasks on each side;
 * a trend drops the periods before anything happened and is a sentence, not a chart, when it is too thin.
 */

/** Finished tasks each group needs before "with AI" vs "without AI" is compared at all (below it: "Chưa đủ dữ liệu"). */
export const MIN_COMPARE_SAMPLE = 20;
/** Finished tasks with a due date a personal on-time rate needs; fewer and it reads "chưa có" (with why behind ⓘ). */
export const MIN_RATE_SAMPLE = 3;
/** Fewest periods a trimmed trend keeps (so a new install is not one lone bar). */
const MIN_TREND_PERIODS = 4;
/** Periods with data a chart needs; fewer and it reads as a sentence instead. */
const MIN_CHART_PERIODS = 3;

/** Both groups have enough finished tasks to compare. */
export const enoughToCompare = (a: number, b: number, min = MIN_COMPARE_SAMPLE) => a >= min && b >= min;

/** One side of a with-AI / without-AI comparison: tasks finished, those with a due date, on time, median days to done. */
export interface OutcomeGroup {
  done: number;
  dated: number;
  onTime: number;
  cycleDays: number | null;
}
/** A compared figure with the number of tasks behind each side, so the reader sees how much it rests on. */
export interface Compared {
  ai: number;
  other: number;
  nAi: number;
  nOther: number;
}

/**
 * Days to done and on-time share, with AI against without, each only when both sides have `min` tasks behind that
 * figure (finished tasks for days, finished tasks with a due date for on time). Below it the figure is null and the
 * counts say why.
 */
export function compareOutcomes(a: OutcomeGroup, o: OutcomeGroup, min = MIN_COMPARE_SAMPLE): { days: Compared | null; onTime: Compared | null } {
  const days = enoughToCompare(a.done, o.done, min) && a.cycleDays != null && o.cycleDays != null ? { ai: a.cycleDays, other: o.cycleDays, nAi: a.done, nOther: o.done } : null;
  const onTime = enoughToCompare(a.dated, o.dated, min) ? { ai: share(a.onTime, a.dated)!, other: share(o.onTime, o.dated)!, nAi: a.dated, nOther: o.dated } : null;
  return { days, onTime };
}

/** n / d as a whole percentage, or null when there is nothing to divide (0 dated tasks is "chưa có", not 0%). */
export const share = (n: number, d: number): number | null => (d > 0 ? Math.round((n / d) * 100) : null);

/**
 * Index of the first period to show: leading periods where every series is empty are dropped, keeping at least
 * `keep` periods (or all of them when there are fewer).
 */
export function firstShown(series: number[][], keep = MIN_TREND_PERIODS): number {
  const len = Math.max(0, ...series.map((s) => s.length));
  let lead = 0;
  while (lead < len - keep && series.every((s) => !(s[lead] ?? 0))) lead++;
  return lead;
}

/** The periods that carry any value, across every series. */
export function periodsWithData(series: number[][]): number {
  const len = Math.max(0, ...series.map((s) => s.length));
  let n = 0;
  for (let i = 0; i < len; i++) if (series.some((s) => (s[i] ?? 0) > 0)) n++;
  return n;
}

/** Enough periods with data to draw a chart (else say it in a sentence). */
export const chartable = (series: number[][], min = MIN_CHART_PERIODS) => periodsWithData(series) >= min;
