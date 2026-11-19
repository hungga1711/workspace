import { CONSUMER_GROUPS } from "@workspace/contracts";
import { consumeEvents, type EventBus, type EventConsumer } from "@workspace/service-kit";
import type { ToolContext, ToolResult } from "./tools.js";

/**
 * Recent read-tool results, per person. The same question asked again a minute later (a regenerate, a
 * follow-up that needs the same list, the same question in @AI and in Hỏi đáp) reads the same data: the module round
 * trips are skipped and the answer starts at once. Only reads are kept, only for a short while, and anything the person
 * changes through the AI clears their entries, so a change they just made is never answered from before it.
 *
 * In memory, one process (ADR 0021), bounded: the oldest entries go first. Authorization still runs on every call
 * (tools.ts executeTool checks the permission and audits before it looks here); only the module call is skipped.
 */

const TTL_MS = 90_000;
const MAX_ENTRIES = 400;
/** A result this long (a whole export) is not worth holding. */
const MAX_CHARS = 60_000;

const reads = new Set<string>();
const writes = new Set<string>();

/** Which tools only read (safe to answer from a recent result) and which change something (clear the person's entries). */
export function markTools(read: Iterable<string>, write: Iterable<string>): void {
  for (const n of read) reads.add(n);
  for (const n of write) {
    writes.add(n);
    reads.delete(n);
  }
}

const entries = new Map<string, { at: number; userId: string; result: ToolResult }>();

/** Everything the result depends on: who asks (and as which agent), the language and zone it is written in, the call. */
function keyOf(ctx: ToolContext, name: string, input: unknown): string {
  return JSON.stringify([ctx.principal.id, ctx.agentId, ctx.lang ?? "", ctx.loc ?? "", ctx.timeZone ?? "", name, stable(input)]);
}

/** The input with its keys in order: {a, b} and {b, a} are the same call. */
function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => [k, stable((v as Record<string, unknown>)[k])]),
    );
  return v;
}

/** Off in tests unless a test turns it on: most tests change data between two identical calls on purpose. */
let enabled = process.env.AI_TOOL_CACHE !== "0" && !process.env.VITEST;
export function setToolCache(on: boolean): void {
  enabled = on;
  entries.clear();
}

/** A recent result of the same read by the same person, or undefined. */
export function cachedRead(ctx: ToolContext, name: string, input: unknown, now = Date.now()): ToolResult | undefined {
  if (!enabled || !reads.has(name)) return undefined;
  const key = keyOf(ctx, name, input);
  const hit = entries.get(key);
  if (!hit) return undefined;
  if (now - hit.at > TTL_MS) {
    entries.delete(key);
    return undefined;
  }
  return hit.result;
}

/** After a call: a read's good result is kept; a change by this person clears what was kept for them. */
export function afterCall(ctx: ToolContext, name: string, input: unknown, result: ToolResult, now = Date.now()): void {
  if (!enabled) return;
  if (writes.has(name)) {
    if (result.ok) forget(ctx.principal.id);
    return;
  }
  if (!reads.has(name) || !result.ok || result.content.length > MAX_CHARS) return;
  const key = keyOf(ctx, name, input);
  entries.delete(key);
  entries.set(key, { at: now, userId: ctx.principal.id, result });
  // Insertion order is age: the first entries are the oldest.
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
}

/** Drops one person's kept results (they changed something). */
export function forget(userId: string): void {
  for (const [k, v] of entries) if (v.userId === userId) entries.delete(k);
}

/**
 * Something changed in the workspace (a domain event: a task moved in the UI, a message, a leave approved): nothing
 * kept may be read again. The whole cache goes; it is small, and which entries a change touches is not worth working out.
 */
export function clearToolCache(): void {
  entries.clear();
}

/**
 * Clears the cache on every change in the workspace (consumer group ai-tool-cache). No database work, only a Map
 * cleared; through consumeEvents without a processed_events row: a repeated delivery costs one extra clear.
 */
export function clearOnChanges(bus: EventBus): Promise<EventConsumer> {
  return consumeEvents({ bus, groupId: "ai-tool-cache", topics: [...CONSUMER_GROUPS["ai-tool-cache"]], handle: async () => clearToolCache() });
}

export const toolCacheSize = () => entries.size;
