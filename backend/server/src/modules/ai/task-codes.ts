/**
 * Task codes typed in a prompt ("summarise T-157", "OPS-12 is late"). Upper-case prefix, a dash, digits; a code is
 * only ever a suggestion, resolved against tasks the person can see before anyone is asked to confirm it, so the
 * pattern can be loose. Common non-task tokens (GPT-4, COVID-19, ISO-9001) are skipped so they never take the slot.
 */
const CODE = /(?<![A-Za-z0-9_-])([A-Z][A-Z0-9]{0,9}-\d{1,7})(?![A-Za-z0-9_-])/g;
/**
 * ClickUp task ids as people paste them ("#86b1x2y3z", 7–12 letters and digits with at least one of each), and
 * ClickUp's branch convention "CU-86b1x2y3z". Synced ClickUp tasks without a custom id carry "#<ID>" as their key.
 */
const CLICKUP = /(?<![A-Za-z0-9_#])(?:#|CU-)([0-9a-z]{7,12})(?![A-Za-z0-9_-])/gi;
const clickupId = (id: string) => /\d/.test(id) && /[a-z]/i.test(id);
const NOT_TASKS = new Set([
  "GPT",
  "COVID",
  "ISO",
  "UTF",
  "SHA",
  "RFC",
  "CVE",
  "TLS",
  "SSL",
  "HTTP",
  "IPV",
  "MP",
  "H",
  "ES",
  "ECMA",
  "IEC",
  "EN",
  "PCI",
  "SOC",
  "WCAG",
  "PEP",
  "BS",
  "NO",
  "GDPR",
]);

export function promptTaskCodes(text: string, max = 5): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(CODE)) {
    const code = m[1]!;
    if (NOT_TASKS.has(code.slice(0, code.indexOf("-")))) continue;
    if (!out.includes(code)) out.push(code);
    if (out.length >= max) return out;
  }
  for (const m of text.matchAll(CLICKUP)) {
    if (!clickupId(m[1]!)) continue;
    const code = `#${m[1]!.toUpperCase()}`;
    if (!out.includes(code)) out.push(code);
    if (out.length >= max) break;
  }
  return out;
}
