export type DiffLine = { type: "same" | "add" | "del"; text: string };

/**
 * Line diff (longest common subsequence) for comparing document versions. Inputs are capped so a
 * huge document cannot freeze the page; past the cap the rest is shown as removed/added.
 */
export function diffLines(before: string, after: string, cap = 3000): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const A = a.slice(0, cap);
  const B = b.slice(0, cap);
  const n = A.length;
  const m = B.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = A[i] === B[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      out.push({ type: "same", text: A[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) out.push({ type: "del", text: A[i++]! });
    else out.push({ type: "add", text: B[j++]! });
  }
  while (i < n) out.push({ type: "del", text: A[i++]! });
  while (j < m) out.push({ type: "add", text: B[j++]! });
  for (const t of a.slice(cap)) out.push({ type: "del", text: t });
  for (const t of b.slice(cap)) out.push({ type: "add", text: t });
  return out;
}
