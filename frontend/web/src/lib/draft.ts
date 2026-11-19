"use client";

import { useEffect, useRef, useState } from "react";

const KEY = (k: string) => `wos_draft_${k}`;

/**
 * Text a person is still writing, kept in this browser per target (a task's AI question, a description) until it is
 * sent or cleared. Read after mount, so the server render and the first client render agree.
 */
export function useDraft(key: string | null, initial = ""): [string, (v: string) => void] {
  const [text, setTextRaw] = useState(initial);
  const loaded = useRef<string | null>(null);
  useEffect(() => {
    if (!key || loaded.current === key) return;
    loaded.current = key;
    try {
      const saved = localStorage.getItem(KEY(key));
      if (saved) setTextRaw(saved);
    } catch {
      /* storage blocked */
    }
  }, [key]);
  const setText = (v: string) => {
    setTextRaw(v);
    if (!key) return;
    try {
      if (v.trim()) localStorage.setItem(KEY(key), v);
      else localStorage.removeItem(KEY(key));
    } catch {
      /* storage blocked */
    }
  };
  return [text, setText];
}

/** Asks before the tab closes or reloads while `dirty` (text written here that no draft keeps). */
export function useLeaveWarning(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
}
