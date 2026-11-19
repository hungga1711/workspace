import { logger } from "./logger.js";

/**
 * Graceful shutdown for the one server process. Outbox relays, event consumers and jobs register themselves when
 * they start; `drain()` stops them in this order, each phase waiting for the work it has in hand:
 *
 *   relays (no new dispatch; the round in flight finishes) → consumers (handlers in flight finish) → jobs
 *
 * Consumers stop after relays because a stopped consumer acknowledges whatever it is handed: a relay still running
 * would then mark rows published that nobody handled. Anything cut short by the deadline is safe to repeat (the
 * outbox delivers again, consumers dedupe); draining only keeps side effects outside the database (push, email)
 * from repeating after a restart.
 */
export type ShutdownPhase = "relays" | "consumers" | "jobs";
const PHASES: ShutdownPhase[] = ["relays", "consumers", "jobs"];
const stops = new Map<ShutdownPhase, Set<() => unknown>>(PHASES.map((p) => [p, new Set()]));

/** Registers a stop; returns its removal (for something stopped on its own, e.g. in tests). */
export function onShutdown(phase: ShutdownPhase, stop: () => unknown): () => void {
  const set = stops.get(phase)!;
  set.add(stop);
  return () => void set.delete(stop);
}

/** Stops everything registered, phase by phase, within `timeoutMs`; resolves false if the deadline cut it short. */
export async function drain(timeoutMs: number): Promise<boolean> {
  const run = (async () => {
    for (const phase of PHASES) {
      const fns = [...stops.get(phase)!];
      stops.get(phase)!.clear();
      const results = await Promise.allSettled(fns.map(async (fn) => fn()));
      for (const r of results) if (r.status === "rejected") logger.warn({ err: r.reason, phase }, "shutdown step failed");
    }
    return true;
  })();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), timeoutMs)));
  try {
    return await Promise.race([run, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
