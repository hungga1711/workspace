"use client";

import { createContext, useContext, useMemo } from "react";
import { api } from "./client";

/**
 * Task codes in free text (chat messages, comments): "T-041" stays readable everywhere the text goes (notifications,
 * search, AI), and the web turns it into a link to the task. The pattern comes from the workspace's code format
 * (Admin › Cài đặt, `codeFormats.task`), plus the default one so tasks numbered before a format change still match.
 */
const DEFAULT_TASK_FORMAT = "T-{seq3}";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A code format as a regex source, or null when it has no fixed text to anchor on (e.g. only `{id10}`). */
export function codeSource(format: string): string | null {
  const parts = format.split(/(\{seq[3-9]\}|\{yyyy\}|\{id10\})/);
  const literal = parts.filter((_, i) => i % 2 === 0).join("");
  if (!/[A-Za-z]/.test(literal)) return null;
  return parts
    .map((p, i) => {
      if (i % 2 === 0) return escape(p);
      if (p === "{yyyy}") return "\\d{4}";
      if (p === "{id10}") return "[0-9A-HJKMNP-TV-Z]{10}";
      return `\\d{${p.slice(4, 5)},}`;
    })
    .join("");
}

/** Source of a regex matching any task code of the workspace (no flags, no groups), or null. */
export function taskCodePattern(format: string | null | undefined): string | null {
  const sources = [...new Set([format ?? DEFAULT_TASK_FORMAT, DEFAULT_TASK_FORMAT])].map(codeSource).filter((x): x is string => !!x);
  return sources.length ? `(?<![\\w-])(?:${sources.join("|")})(?![\\w-])` : null;
}

const Ctx = createContext<string | null>(taskCodePattern(DEFAULT_TASK_FORMAT));

export function TaskRefsProvider({ format, children }: { format: string | null | undefined; children: React.ReactNode }) {
  return <Ctx.Provider value={taskCodePattern(format)}>{children}</Ctx.Provider>;
}

/** The workspace's task-code pattern as a global regex (a fresh one per render: global regexes carry state). */
export function useTaskCodeRe(): RegExp | null {
  const src = useContext(Ctx);
  return useMemo(() => (src ? new RegExp(src, "gi") : null), [src]);
}

export interface TaskBrief {
  id: string;
  code: string;
  title: string;
  status: string;
  assigneeId: string | null;
}

// One lookup per code per page view: a channel shows the same codes many times. `null` = not found or not readable.
const cache = new Map<string, Promise<TaskBrief | null>>();

export function lookupTask(code: string): Promise<TaskBrief | null> {
  const key = code.toUpperCase();
  let hit = cache.get(key);
  if (!hit) {
    hit = api<{ task: TaskBrief }>(`work/tasks/${encodeURIComponent(key)}`)
      .then(({ task }) => ({ id: task.id, code: task.code, title: task.title, status: task.status, assigneeId: task.assigneeId }))
      .catch(() => null);
    cache.set(key, hit);
  }
  return hit;
}
