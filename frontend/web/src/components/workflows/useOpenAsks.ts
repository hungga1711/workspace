"use client";

import { useFeature } from "@/lib/features-context";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { ASKS_CHANGED } from "./AskForm";
import type { OpenAsk } from "./types";

type Raw = {
  asks: Omit<OpenAsk, "kind">[];
  approvals?: { runId: string; taskId: string; taskCode: string; taskTitle: string; workflowName: string; stepTitle: string | null; waitingSince: string }[];
};

/*
 * One poll per tab, shared by every component that asks (the sidebar, the chat index, Workflows): before, each hook
 * ran its own timer, so a page with two of them read twice every 30 s. Reads once the page is idle, then every 60 s
 * while the tab is visible, when the tab comes back, and right after an answer (ASKS_CHANGED).
 */
let current: OpenAsk[] = [];
let lastAt = 0;
let inFlight: Promise<void> | null = null;
const listeners = new Set<(a: OpenAsk[]) => void>();
let timer: ReturnType<typeof setInterval> | undefined;

function load(force = false) {
  if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
  if (!force && Date.now() - lastAt < 10_000) return;
  inFlight ??= api<Raw>("work/agent-questions/open")
    .then((r) => {
      const approvals: OpenAsk[] = (r.approvals ?? []).map((a) => ({ ...a, kind: "approval", id: `ap-${a.runId}`, round: 0, count: 0, askedAt: a.waitingSince }));
      current = [...r.asks.map((a) => ({ ...a, kind: "ask" as const })), ...approvals].sort((a, b) => b.askedAt.localeCompare(a.askedAt));
      lastAt = Date.now();
      listeners.forEach((l) => l(current));
    })
    .catch(() => undefined)
    .finally(() => {
      inFlight = null;
    });
}
const onVisible = () => load();
const onChanged = () => load(true);

function subscribe(l: (a: OpenAsk[]) => void) {
  listeners.add(l);
  if (listeners.size === 1) {
    timer = setInterval(() => load(), 60_000);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener(ASKS_CHANGED, onChanged);
  }
  return () => {
    listeners.delete(l);
    if (listeners.size) return;
    clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener(ASKS_CHANGED, onChanged);
  };
}

/**
 * What agent runs wait on me right now (GET work/agent-questions/open): the AI's questions and the approvals that are
 * mine to give, newest first. The chat sidebar's temporary "Waiting for you" items and the inbox's tile. Nothing is
 * stored in chat: the items come and go with the runs' open rounds.
 */
export function useOpenAsks(): OpenAsk[] {
  // An installation without AI (left out at deploy time) has no agents: nothing to ask the server for.
  const on = useFeature("ai");
  const [asks, setAsks] = useState<OpenAsk[]>(current);
  useEffect(() => {
    if (!on) return;
    const off = subscribe(setAsks);
    const idle = typeof requestIdleCallback === "function" ? requestIdleCallback(() => load(), { timeout: 4000 }) : (setTimeout(() => load(), 1500) as unknown as number);
    return () => {
      off();
      if (typeof cancelIdleCallback === "function") cancelIdleCallback(idle);
      else clearTimeout(idle);
    };
  }, [on]);
  return on ? asks : [];
}
