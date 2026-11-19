import "server-only";
import { cache } from "react";
import { gw } from "./gateway";
import { readSession } from "./session";

/**
 * Whether the company has an AI provider configured (ai module `GET /status`). Every company-AI
 * surface (Trợ lý AI, @AI, AskTeam, brief, summarize/translate, task/doc AI panels, agents) is
 * hidden when it is false. Extension monitoring (Công việc › AI, Của tôi › AI) never depends on it.
 *
 * The answer is kept for a short while per workspace (no extra backend call on most navigations) and once per
 * request via React `cache`. A failed check (signed out, gateway restarting) counts as "not configured" for that
 * request only: caching it would hide AI right after sign-in or setup until the memo expired.
 */
export interface AiStatus {
  configured: boolean;
  providers: string[];
  /** Company assistant usable: the switch is on (Admin › AI) and a model is connected. */
  assistant: boolean;
  /** Extension monitoring switched on. */
  monitoring: boolean;
  /** The assistant switch alone, connected or not. */
  assistantWanted: boolean;
}
const OFF: AiStatus = { configured: false, providers: [], assistant: false, monitoring: false, assistantWanted: false };

const TTL_MS = 30_000;
const memo = new Map<string, { at: number; value: AiStatus }>();

export const aiStatus = cache(async (): Promise<AiStatus> => {
  // Per person: test installations recreate the workspace (and its owner) between suites within the TTL.
  const key = (await readSession())?.userId ?? "";
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  try {
    const value = await gw<Partial<AiStatus>>("/api/ai/status");
    const status: AiStatus = {
      configured: !!value.configured,
      providers: value.providers ?? [],
      assistant: value.assistant === true,
      monitoring: value.monitoring === true,
      assistantWanted: value.assistantWanted === true,
    };
    memo.set(key, { at: Date.now(), value: status });
    return status;
  } catch {
    // The gateway refused or is restarting: keep the last answer this person got (even past its TTL) rather than
    // telling them AI is off; only with nothing known yet does AI count as off for this request.
    return hit?.value ?? OFF;
  }
});

/** Call after an admin changes the AI provider settings, so the next request re-reads the status. */
export function invalidateAiStatus() {
  memo.clear();
}

/** True when the company records staff AI use through the browser extension (Admin › AI). */
export async function aiMonitoring(): Promise<boolean> {
  return (await aiStatus()).monitoring;
}
