import { AsyncLocalStorage } from "node:async_hooks";
import type { NextFunction, Request, Response } from "express";
import type { Pool } from "pg";
import { deviceKey, deviceOnline } from "./device-hub.js";

/**
 * Each person's own AI. The company's connection (Admin › AI) answers for everyone by default; a person
 * may pick an AI found on one of their own connected computers instead (AI › Connect), and from then on their own
 * requests are answered there. Only their own: the choice is looked up for the signed-in person at the start of each
 * request and kept for that request alone (AsyncLocalStorage), and a model call uses it only when it is made for that
 * same person (`ModelRequest.person`). Background jobs, service calls and other people's requests never see it.
 *
 * The computer must be on: while it is not, the company's AI answers (workspace-gateway.ts), and AI › Connect says so.
 * The company may keep everyone on its own connection (ai_policy.allow_personal_ai).
 */
export interface PersonalAi {
  device: string;
  ai: string;
  /** A model server's model; "" for a command-line agent. */
  model: string;
  /** What the person sees: "Ollama · llama3 · Lan's MacBook". */
  label: string;
  /** The AI's name ("Claude Code"), and the models it offers on that computer (the composer lists each one). */
  name?: string;
  models?: string[];
}

interface Choice extends PersonalAi {
  allowed: boolean;
}

const als = new AsyncLocalStorage<{ userId: string; ai: PersonalAi }>();

/** The person whose request this is, and their AI, while their computer is on. */
export const personalNow = () => als.getStore() ?? null;

/** Tests, and the middleware below: runs `fn` as `userId`'s request with their own AI. */
export const runWithPersonal = <T>(userId: string, ai: PersonalAi, fn: () => T): T => als.run({ userId, ai }, fn);

const TTL_MS = 30_000;
const memo = new Map<string, { at: number; value: Choice | null }>();

/** After a person changes their choice, a computer is forgotten or the company changes its rule. */
export function forgetPersonal(userId?: string) {
  if (userId) memo.delete(userId);
  else memo.clear();
}

interface Row {
  device: string;
  ai: string;
  model: string;
  found: { id: string; name: string; kind: string; models?: string[] }[] | null;
  allowed: boolean | null;
}

/** A person's saved choice, if the AI is still on that computer. Kept 30 s: every request to the ai module asks. */
export async function choiceOf(pool: Pool, userId: string): Promise<Choice | null> {
  const hit = memo.get(userId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const r = (
    await pool.query<Row>(
      `SELECT c.device, c.ai, c.model, d.found, (SELECT allow_personal_ai FROM ai_policy LIMIT 1) AS allowed
         FROM ai_personal_choice c JOIN ai_local_devices d ON d.user_id = c.user_id AND d.device = c.device AND d.last_seen_at IS NOT NULL
        WHERE c.user_id = $1`,
      [userId],
    )
  ).rows[0];
  const value = r ? toChoice(r) : null;
  if (memo.size > 5000) memo.clear();
  memo.set(userId, { at: Date.now(), value });
  return value;
}

export function toChoice(r: Row): Choice | null {
  const f = (r.found ?? []).find((x) => x.id === r.ai);
  // The AI was uninstalled, or the model removed from the server: back to the company's AI.
  if (!f || (r.model && !f.models?.includes(r.model))) return null;
  return {
    device: r.device,
    ai: r.ai,
    model: r.model,
    label: [f.name, r.model, r.device].filter(Boolean).join(" · "),
    name: f.name,
    models: f.models ?? [],
    allowed: r.allowed !== false,
  };
}

/** The choice that applies now: allowed by the company and the computer on. */
export const usable = (userId: string, c: Choice | null, online = deviceOnline) => !!c && c.allowed && online(deviceKey(userId, c.device));

/** Express middleware, after the principal one: the signed-in person's own AI for the rest of the request. */
export function personalAiMiddleware(pool: Pool) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const p = req.principal;
    if (p?.type !== "user") return next();
    const c = await choiceOf(pool, p.id).catch(() => null);
    if (!usable(p.id, c)) return next();
    const { allowed: _allowed, ...ai } = c!;
    runWithPersonal(p.id, ai, next);
  };
}
