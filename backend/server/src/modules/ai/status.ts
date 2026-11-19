import { logger, type ServiceClient } from "@workspace/service-kit";
import type { NextFunction, Request, Response } from "express";
import type { ModelProvider } from "./providers.js";

/**
 * Whether the company has configured an AI provider (a hosted vendor key: OpenAI or any
 * OpenAI-compatible base URL, Anthropic, Gemini). Without one, the ai module only runs the local
 * extractive model, which is not an assistant: the web hides company-AI features and the
 * generation endpoints below refuse with 503 `ai_not_configured`.
 *
 * Extension monitoring (internal/monitor/events, monitor/connection, oversight*, policy) never
 * depends on this: tracking what staff do with ChatGPT/Claude needs no company AI.
 */
export interface AiStatus {
  configured: boolean;
  providers: string[];
  /** The company turned the assistant on (Admin › AI) and a model is connected. */
  assistant: boolean;
  /** The company turned extension monitoring on. */
  monitoring: boolean;
  /** The assistant switch alone (a model may still be missing): Admin › AI shows connections, the checklist nags. */
  assistantWanted: boolean;
}

export interface AiFlags {
  assistant: boolean;
  monitoring: boolean;
}

/** The workspace's two AI switches, read from platform's internal workspace view and kept a few seconds. */
let flagsMemo: { at: number; value: AiFlags } | undefined;
export async function aiFlags(d: { platform?: ServiceClient | undefined }): Promise<AiFlags> {
  if (!d.platform) return { assistant: true, monitoring: true };
  const hit = flagsMemo;
  if (hit && Date.now() - hit.at < 10_000) return hit.value;
  try {
    const t = await d.platform.request<{ features?: Record<string, boolean> }>("GET", "/internal/workspace");
    const value = { assistant: t.features?.aiAssistant === true, monitoring: t.features?.aiMonitoring === true };
    flagsMemo = { at: Date.now(), value };
    return value;
  } catch (err) {
    // Platform unreachable (or not set up yet): answer with the last known switches, else fail closed (AI off)
    // rather than 500 on /status.
    logger.warn({ err }, "could not read the AI switches from platform");
    return hit?.value ?? { assistant: false, monitoring: false };
  }
}
/** After Admin › AI changes a switch, so the next status answers with it. */
export function forgetAiFlags() {
  flagsMemo = undefined;
}

/**
 * `AI_LOCAL_MODEL=1` (tests, demos, air-gapped trials): treat the built-in extractive model as the company's AI,
 * so AI features run end to end without any provider. It answers from workspace data only; never set in production.
 */
const localModelAsAi = (env: NodeJS.ProcessEnv = process.env) => env.AI_LOCAL_MODEL === "1";

export function aiStatus(provider: ModelProvider, flags: AiFlags = { assistant: true, monitoring: true }, env: NodeJS.ProcessEnv = process.env): AiStatus {
  const real = connectedProviders(provider);
  const configured = real.length > 0 || localModelAsAi(env);
  return {
    configured,
    providers: real.length ? real : configured ? ["local"] : [],
    assistant: flags.assistant && configured,
    monitoring: flags.monitoring,
    assistantWanted: flags.assistant,
  };
}

function connectedProviders(provider: ModelProvider): string[] {
  const gw = provider as ModelProvider & { providers?: () => string[]; menu?: () => { label: string }[] };
  // The workspace gateway (env vendors + Admin › AI connections) names what is configured.
  if (typeof gw.menu === "function") return gw.menu().map((m) => m.label);
  // The gateway lists the vendors it has a key for; a provider injected directly (tests) counts unless it is the local one.
  return typeof gw.providers === "function" ? gw.providers() : provider.name === "local" ? [] : [provider.name];
}

/** Routes that need a model to be useful. Everything else (history, usage, oversight, monitor, policy) keeps working. */
const GENERATIVE: RegExp[] = [
  /^\/ask$/,
  /^\/translate$/,
  /^\/threads\/[^/]+\/summarize$/,
  /^\/agents\/[^/]+\/invoke$/,
  /^\/internal\/brief$/,
  /^\/extract$/,
  /^\/tasks\/[^/]+\/assist$/,
  /^\/docs\/[^/]+\/assist$/,
  /^\/tasks\/[^/]+\/chat$/,
  /^\/tasks\/write$/,
  /^\/whiteboard\/(summarize|cluster|ideas)$/,
  /^\/assistant\/messages(\/stream)?$/,
  /^\/assistant\/pending\/[^/]+$/,
  /^\/assistant\/conversations\/[^/]+\/regenerate(\/stream)?$/,
  /^\/progress\/analyze$/,
  /^\/adoption\/analyze$/,
  /^\/adoption\/prompt$/,
];

export function isGenerativeRoute(method: string, path: string): boolean {
  return method === "POST" && GENERATIVE.some((r) => r.test(path));
}

/** Express middleware: 503 `ai_not_configured` on a generative route when no provider is configured. */
export function requireAiConfigured(provider: ModelProvider) {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Loads this workspace's connections (cached) so every sync read in the request sees them.
    await (provider as { ready?: () => Promise<unknown> }).ready?.();
    const path = (req.originalUrl ?? req.url).split("?")[0] ?? "";
    if (isGenerativeRoute(req.method, path) && !aiStatus(provider).configured) {
      res.status(503).json({ error: "ai_not_configured", message: "No AI provider is configured for this workspace" });
      return;
    }
    next();
  };
}
