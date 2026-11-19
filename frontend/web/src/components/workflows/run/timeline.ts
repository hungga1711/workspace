import type { AskRound, Run, RunStep, StepActivity, StepEntry } from "../types";

/**
 * A run as one timeline: everything that happened to it, in the order it happened, from
 * what the run keeps (who started it, the environment, each step's history, the rounds of questions) and what its
 * agents did (the activity lines). Pure, so the order and the clock are tested without a page.
 */
export type Moment = { id: string; at: number; step: number } & (
  | { kind: "started"; by: string; inputs: [string, string][] }
  | { kind: "env"; state: "preparing" | "ready" | "failed" }
  /** A step begins an attempt (its `n`th); a command step's line is the command. */
  | { kind: "attempt"; n: number; text: string }
  /** One row of what the agent did: an action with how it ended, its own words, an error, a note. */
  | { kind: "activity"; events: StepActivity[] }
  /** The attempt is over: how, and what came back. */
  | { kind: "ended"; n: number; entry: StepEntry }
  /** What happened to the step besides running: a verdict, work sent back, an approval, an answer, a retry. */
  | { kind: "note"; entry: StepEntry }
  | { kind: "asked"; round: AskRound }
  /** An approval step starts waiting for its approver. */
  | { kind: "awaiting" }
  /** Nothing happened for a while: `ms` long, and whether the run was waiting for people. */
  | { kind: "gap"; ms: number; people: boolean }
  | { kind: "finished"; status: "done" | "failed" | "cancelled"; error: string | null }
);

/** A step whose start line and history entry are the same attempt are this close. */
const SAME_ATTEMPT_MS = 3000;
/** Quiet longer than this is said as a gap. */
export const GAP_MS = 60_000;
// Same instant: the order things are written in.
const RANK: Record<Moment["kind"], number> = { started: 0, env: 1, awaiting: 2, attempt: 3, activity: 4, asked: 5, ended: 6, note: 7, gap: 8, finished: 9 };

type RunFacts = Pick<Run, "id" | "status" | "startedBy" | "createdAt" | "finishedAt" | "error" | "inputs" | "config" | "env" | "asks"> & {
  steps: Pick<RunStep, "kind" | "history" | "startedAt" | "state">[];
};

export function buildTimeline(run: RunFacts, events: StepActivity[]): Moment[] {
  const out: (Moment & { seq: number })[] = [];
  let seq = 0;
  const add = (m: Moment) => out.push({ ...m, seq: seq++ });
  const ms = (s: string | null | undefined) => (s ? Date.parse(s) : NaN);
  const label = (key: string) => run.config?.inputs.find((f) => f.key === key)?.label ?? key;

  add({ id: "started", at: ms(run.createdAt), step: -1, kind: "started", by: run.startedBy, inputs: Object.entries(run.inputs ?? {}).map(([k, v]) => [label(k), String(v)]) });
  if (run.env) {
    const at = ms(run.env.finishedAt) || ms(run.env.startedAt);
    if (!Number.isNaN(at)) add({ id: "env", at, step: -1, kind: "env", state: run.env.state });
  }

  // What the agents did: an action and how it ended are one row; each step's start lines are its attempts.
  const starts = new Map<number, { at: number; text: string; id: number }[]>();
  let open: (Moment & { kind: "activity" }) | null = null;
  for (const e of [...events].sort((a, b) => a.id - b.id)) {
    const at = ms(e.at);
    if (e.kind === "draft") continue;
    if (e.kind === "start") {
      starts.set(e.step, [...(starts.get(e.step) ?? []), { at, text: e.text, id: e.id }]);
      open = null;
      continue;
    }
    const last = open?.events[0];
    if ((e.kind === "result" || e.kind === "error") && open && last?.kind === "tool" && open.events.length === 1 && open.step === e.step && (!e.tool || e.tool === last.tool)) {
      open.events.push(e);
      open = null;
      continue;
    }
    // How an action ended, with no action before it on record, says nothing by itself.
    if (e.kind === "result") continue;
    const m: Moment & { kind: "activity" } = { id: `e${e.id}`, at, step: e.step, kind: "activity", events: [e] };
    add(m);
    open = e.kind === "tool" ? (out[out.length - 1] as unknown as typeof m) : null;
  }

  run.steps.forEach((s, step) => {
    const attempts = (s.history ?? []).filter((h) => h.kind === "attempt");
    // Attempts in the order they began: those the agent's lines open, and those only the history knows (older runs).
    const begun = [...(starts.get(step) ?? [])].map((x) => ({ ...x, entry: undefined as StepEntry | undefined }));
    for (const h of attempts) {
      const at = ms(h.at);
      const same = begun.find((b) => !b.entry && Math.abs(b.at - at) <= SAME_ATTEMPT_MS);
      if (same) same.entry = h;
      else begun.push({ at, text: "", id: 0, entry: h });
    }
    begun.sort((a, b) => a.at - b.at);
    begun.forEach((b, i) => {
      add({ id: `a${step}.${i}`, at: b.at, step, kind: "attempt", n: i + 1, text: b.text });
      // A check's attempt ends in its verdict, which is its own moment.
      if (b.entry?.outcome && b.entry.end && s.kind !== "check") add({ id: `x${step}.${i}`, at: ms(b.entry.end), step, kind: "ended", n: i + 1, entry: b.entry });
    });
    (s.history ?? []).forEach((h, i) => {
      if (h.kind !== "attempt") add({ id: `h${step}.${i}`, at: ms(h.at), step, kind: "note", entry: h });
    });
    if (s.kind === "approval" && s.startedAt) add({ id: `w${step}`, at: ms(s.startedAt), step, kind: "awaiting" });
  });

  for (const r of run.asks ?? []) add({ id: `q${r.id}`, at: ms(r.askedAt), step: r.stepIndex, kind: "asked", round: r });

  if (run.finishedAt && (run.status === "done" || run.status === "failed" || run.status === "cancelled"))
    add({ id: "finished", at: ms(run.finishedAt), step: -1, kind: "finished", status: run.status, error: run.error });

  // In the same instant a verdict comes before the work it sends back.
  const rank = (m: Moment) => RANK[m.kind] + (m.kind === "note" && m.entry.kind !== "checked" ? 0.5 : 0);
  const sorted = out.filter((m) => !Number.isNaN(m.at)).sort((a, b) => a.at - b.at || rank(a) - rank(b) || a.seq - b.seq);
  // Long quiet stretches are said, with whether people were being waited for.
  const withGaps: Moment[] = [];
  let people = false;
  sorted.forEach(({ seq: _seq, ...m }, i) => {
    const prev = sorted[i - 1];
    if (prev && m.at - prev.at >= GAP_MS) withGaps.push({ id: `g${prev.id}`, at: prev.at, step: prev.step, kind: "gap", ms: m.at - prev.at, people });
    // Questions and an approval hold the run for people until someone answers or decides.
    if (m.kind === "asked" || m.kind === "awaiting") people = true;
    else if (m.kind === "attempt" || m.kind === "note" || m.kind === "finished") people = false;
    withGaps.push(m as Moment);
  });
  return withGaps;
}

/**
 * When each moment plays: the run's own pace, except that nothing waits longer than `cap` (an agent thinking for a
 * minute, people answering the next morning). Returns each moment's time on the playback clock and its length.
 */
export function playClock(moments: Pick<Moment, "at">[], cap = 1500): { at: number[]; total: number } {
  const at: number[] = [];
  let t = 0;
  moments.forEach((m, i) => {
    if (i) t += Math.min(Math.max(0, m.at - moments[i - 1]!.at), cap);
    at.push(t);
  });
  return { at, total: t };
}

/** The moment showing at `t` on the playback clock: the last one that has played. */
export function momentAt(clock: { at: number[] }, t: number): number {
  let i = 0;
  while (i + 1 < clock.at.length && clock.at[i + 1]! <= t) i++;
  return i;
}

/** The moment a link points at (`at`, the run's real time in ms): the last one at or before it. */
export function momentFor(moments: Pick<Moment, "at">[], at: number): number {
  let i = 0;
  moments.forEach((m, k) => {
    if (m.at <= at) i = k;
  });
  return i;
}
