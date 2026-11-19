/**
 * Lexicographic ranks for Kanban ordering (fractional indexing): moving a card
 * rewrites one row. Keys use [0-9a-z] and never end in "0", so there is always
 * room to insert before any key.
 */
const DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz";

function midpoint(a: string, b: string | null): string {
  const zero = DIGITS[0]!;
  if (b !== null && a >= b) throw new Error(`rank order violated: ${a} >= ${b}`);
  if (a.endsWith(zero) || (b !== null && b.endsWith(zero))) throw new Error("rank keys must not end in 0");
  if (b !== null) {
    let n = 0;
    while ((a[n] ?? zero) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const da = a ? DIGITS.indexOf(a[0]!) : 0;
  const db = b !== null ? DIGITS.indexOf(b[0]!) : DIGITS.length;
  if (db - da > 1) return DIGITS[Math.round((da + db) / 2)]!;
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS[da]! + midpoint(a.slice(1), null);
}

export function between(a: string | null, b: string | null): string {
  return midpoint(a ?? "", b);
}

export function initialRank(): string {
  return between(null, null);
}
