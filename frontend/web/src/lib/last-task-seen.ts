"use client";

import { useEffect } from "react";

/**
 * The task this person opened last, for the AI Insights browser extension: when the person allowed it on the
 * extension's options page, a prompt sent on ChatGPT, Claude… within two hours carries this task as a hint, which
 * the person confirms in Của tôi › AI before it counts. Only the id and the time, in this browser, never sent
 * anywhere by the web app itself. The event lets the extension read it at once instead of on the next visit.
 */
const LAST_TASK_KEY = "workspace.lastTaskSeen";

export function useLastTaskSeen(taskId: string) {
  useEffect(() => {
    try {
      localStorage.setItem(LAST_TASK_KEY, JSON.stringify({ taskId, at: new Date().toISOString() }));
      window.dispatchEvent(new CustomEvent("workspace:task-seen"));
    } catch {
      // Storage blocked (private mode, policy): the hint is a convenience, nothing depends on it.
    }
  }, [taskId]);
}
