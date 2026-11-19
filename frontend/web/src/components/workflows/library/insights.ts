"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client";
import type { StepKind } from "../types";

/** How the workflows perform (server work/workflows/insights.ts): figures counted from the runs, and rule-made suggestions. */
export interface StepInsight {
  key: string;
  title: string;
  kind: StepKind;
  runs: number;
  done: number;
  failed: number;
  /** ai, command: times its result was sent back. check: times it sent work back. */
  sentBack: number;
  /** check: runs in which it did not pass at least once. */
  notPassed: number;
  retried: number;
  avgSec: number | null;
  avgWaitSec: number | null;
  tokens: { input: number; output: number };
  /** Runs where the step worked with an AI and no token count came back (an agent on someone's computer). */
  tokensUnknown: number;
  models: string[];
}
export interface Suggestion {
  rule: "check_sends_back" | "step_fails" | "fast_model" | "waits_for_people" | "step_reads_much" | "step_slow";
  stepKey?: string;
  step?: string;
  author?: string;
  pct?: number;
  minutes?: number;
}
export interface ModelTokens {
  provider: string | null;
  model: string;
  input: number;
  output: number;
}
export interface WorkflowInsight {
  id: string | null;
  name: string;
  runs: number;
  done: number;
  failed: number;
  cancelled: number;
  active: number;
  tokens: { input: number; output: number };
  tokensUnknownRuns: number;
  models: ModelTokens[];
  avgSec: number | null;
  avgWorkSec: number | null;
  avgWaitSec: number | null;
  sentBack: number;
  steps: StepInsight[];
  suggestions: Suggestion[];
}
export interface Insights {
  days: number;
  capped: boolean;
  totals: { runs: number; done: number; failed: number; tokens: { input: number; output: number }; tokensUnknownRuns: number; workSec: number; waitSec: number; sentBack: number };
  daily: { day: string; runs: number; failed: number; tokens: number }[];
  workflows: WorkflowInsight[];
}
/** USD per million tokens, or null when nobody knows the price (ai `spend/quote`). */
export type Prices = Record<string, { inputPerMTok: number; outputPerMTok: number; source: "company" | "list" } | null>;

/**
 * What these tokens cost at the known prices. `usd` is null when no model of them has a price; `unpriced` counts the
 * tokens left out, so a partial figure can say it is partial. Always an estimate: the provider's bill is the truth.
 */
export function costOf(models: ModelTokens[], prices: Prices | null): { usd: number | null; unpriced: number } {
  if (!prices) return { usd: null, unpriced: models.reduce((n, m) => n + m.input + m.output, 0) };
  let usd = 0;
  let priced = false;
  let unpriced = 0;
  for (const m of models) {
    const p = prices[m.model];
    if (!p) unpriced += m.input + m.output;
    else {
      priced = true;
      usd += (m.input * p.inputPerMTok + m.output * p.outputPerMTok) / 1_000_000;
    }
  }
  return { usd: priced ? usd : null, unpriced };
}

/** 1,240 → "1.2k", 3,400,000 → "3.4M": tokens in the unit people compare. */
export function shortTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0).replace(/\.0$/, "")}M`;
}

/**
 * The figures for a window (and one workflow, on its own page), read when the view opens, then the prices of the
 * models that answered. A failed read is `failed` with a `retry`; failed prices only leave the cost unknown.
 */
export function useInsights(days: number, workflowId?: string) {
  const [state, setState] = useState<{ key: string; data: Insights | null; prices: Prices | null; failed: boolean }>({ key: "", data: null, prices: null, failed: false });
  const [turn, setTurn] = useState(0);
  const key = `${days}:${workflowId ?? ""}:${turn}`;
  useEffect(() => {
    let stop = false;
    void (async () => {
      const data = await api<Insights>(`work/workflows/insights?days=${days}${workflowId ? `&workflowId=${encodeURIComponent(workflowId)}` : ""}`).catch(() => null);
      if (stop) return;
      if (!data) return setState({ key, data: null, prices: null, failed: true });
      setState({ key, data, prices: null, failed: false });
      const models = [...new Set(data.workflows.flatMap((w) => w.models.map((m) => m.model)))].slice(0, 200);
      if (!models.length) return;
      const q = await api<{ prices: Prices }>("ai/spend/quote", { method: "POST", body: { models } }).catch(() => null);
      if (!stop && q) setState((s) => (s.key === key ? { ...s, prices: q.prices } : s));
    })();
    return () => {
      stop = true;
    };
  }, [key, days, workflowId]);
  const retry = useCallback(() => setTurn((n) => n + 1), []);
  return {
    data: state.key === key ? state.data : null,
    prices: state.key === key ? state.prices : null,
    failed: state.key === key && state.failed,
    loading: state.key !== key,
    retry,
  };
}
