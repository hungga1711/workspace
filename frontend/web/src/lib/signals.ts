import { fold } from "./fold";

/**
 * Contextual signals in a chat message ("AI in chat": deadlines, decisions, blockers).
 * Deterministic and local: runs on every visible message without a model call, so it costs
 * nothing and never sends message text anywhere. Vietnamese and English.
 */
export interface Signals {
  deadline: { label: string; iso: string; rel?: 0 | 1 } | null;
  decision: boolean;
  blocker: boolean;
  /** The writer says something is finished ("xong phần API rồi"): offer to close one of their tasks. */
  done: boolean;
}

const WEEKDAY: Record<string, number> = {
  "chu nhat": 0,
  "thu hai": 1,
  "thu 2": 1,
  "thu ba": 2,
  "thu 3": 2,
  "thu tu": 3,
  "thu 4": 3,
  "thu nam": 4,
  "thu 5": 4,
  "thu sau": 5,
  "thu 6": 5,
  "thu bay": 6,
  "thu 7": 6,
};
// English day names need word boundaries ("monday" must not match inside other words); "next Friday" reads as the coming one.
const WEEKDAY_EN: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };

export function detectSignals(text: string, now = new Date(), labels?: { today: string; tomorrow: string }): Signals {
  const f = fold(text.replace(/<@[\w:-]+>/g, ""));
  let deadline: Signals["deadline"] = null;
  // English cues are whole words: "by" inside "maybe" or "baby" is not a deadline.
  const cue = /(truoc|han|cham nhat|trong ngay|toi da)/.test(f) || /\b(deadline|by|due|until|before)\b/.test(f);
  const date = f.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?/);
  if (date) {
    const d = new Date(Number(date[3] ?? now.getFullYear()), Number(date[2]) - 1, Number(date[1]), 17, 0, 0);
    if (!date[3] && d.getTime() < now.getTime() - 86400_000 * 30) d.setFullYear(d.getFullYear() + 1);
    if (!Number.isNaN(d.getTime()) && cue) deadline = { label: `${date[1]}/${date[2]}`, iso: d.toISOString() };
  }
  if (!deadline && cue) {
    const rel = /\b(hom nay|cuoi ngay|today|eod)\b/.test(f) ? 0 : /\b(ngay mai|mai|tomorrow)\b/.test(f) ? 1 : null;
    const vi = Object.keys(WEEKDAY).find((k) => f.includes(k));
    const en = Object.keys(WEEKDAY_EN).find((k) => new RegExp(`\\b${k}\\b`).test(f));
    const wd = vi !== undefined ? WEEKDAY[vi] : en !== undefined ? WEEKDAY_EN[en] : undefined;
    let d: Date | null = null;
    if (rel !== null) {
      d = new Date(now);
      d.setDate(d.getDate() + rel);
    } else if (wd !== undefined) {
      d = new Date(now);
      const diff = (wd - d.getDay() + 7) % 7 || 7;
      d.setDate(d.getDate() + diff);
    }
    if (d) {
      d.setHours(17, 0, 0, 0);
      deadline = {
        label:
          rel === 0
            ? (labels?.today ?? "today")
            : rel === 1
              ? (labels?.tomorrow ?? "tomorrow")
              : `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`,
        iso: d.toISOString(),
        ...(rel === 0 || rel === 1 ? { rel } : {}),
      };
    }
  }
  const decision = /\b(chot|quyet dinh|thong nhat|da duyet|we decided|agreed|let'?s go with|final decision)\b/.test(f) && !/\?\s*$/.test(text.trim());
  const blocker = /(bi chan|dang chan|ket o|bi ket|dang cho .*(phan hoi|duyet|api|key|tai lieu|ben)|blocked|blocker|waiting on|chua the tiep tuc|khong the lam tiep)/.test(f);
  const question = /\?\s*$/.test(text.trim()) || /\b(chua|khong)\s*$/.test(f.trim()) || /\b(xong chua|done yet)\b/.test(f);
  const done =
    !question &&
    !blocker &&
    /\b(da xong|xong roi|lam xong|xong phan|xong viec|hoan thanh|da hoan thanh|da gui|da deploy|da merge|da fix|da sua xong|done|finished|completed|shipped|merged)\b/.test(f);
  return { deadline, decision, blocker, done };
}

const words = (t: string) =>
  new Set(
    fold(t)
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 1 && !STOP.has(w)),
  );
const STOP = new Set([
  "da",
  "xong",
  "roi",
  "phan",
  "viec",
  "cua",
  "cho",
  "va",
  "la",
  "nhe",
  "nha",
  "minh",
  "toi",
  "em",
  "anh",
  "chi",
  "done",
  "the",
  "and",
  "for",
  "lam",
  "hoan",
  "thanh",
]);
/** Orders open tasks by how many words they share with the message, so the likely one comes first. */
export function rankByMessage<T extends { title: string; code: string }>(message: string, tasks: T[]): T[] {
  const m = words(message);
  const score = (t: T) => [...words(`${t.title} ${t.code}`)].filter((w) => m.has(w)).length;
  return tasks
    .map((t, i) => ({ t, i, s: score(t) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.t);
}
