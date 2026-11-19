"use client";

import { createContext, useContext } from "react";

export interface AiFlags {
  /** The company's assistant can be used (switch on, model connected). */
  assistant: boolean;
  /** Staff AI use is recorded through the browser extension. */
  monitoring: boolean;
  /** The assistant switch is on, connected or not. */
  assistantWanted: boolean;
}
const OFF: AiFlags = { assistant: false, monitoring: false, assistantWanted: false };

/**
 * The AI switches for client components, set once in the app layout from the server-side `aiStatus()` (lib/ai.ts):
 * no client fetch. Everything is off outside the provider.
 */
const Ctx = createContext<AiFlags>(OFF);

export function AiProvider({ flags, children }: { flags: AiFlags; children: React.ReactNode }) {
  return <Ctx.Provider value={flags}>{children}</Ctx.Provider>;
}

/** Company assistant on and connected: Trợ lý AI, @AI, summaries, translate, task/doc panels. */
export function useAiEnabled(): boolean {
  return useContext(Ctx).assistant;
}

/** Extension monitoring on: Tiến độ › AI, Của tôi › AI, the extension's connection code. */
export function useAiMonitoring(): boolean {
  return useContext(Ctx).monitoring;
}

export function useAiFlags(): AiFlags {
  return useContext(Ctx);
}
