"use client";

import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useAiEnabled } from "@/lib/ai-context";
import { OPEN_ASK_EVENT, type AskContextRef } from "@/lib/ask-context";
import { useFeature } from "@/lib/features-context";

// The panel (thread, composer, stream) is fetched on the first ⌘J or click: nothing of it ships with a route.
const loadPanel = () => import("./AskPanel");
const AskPanel = dynamic(loadPanel, { ssr: false });

/**
 * Ask AI from any screen (⌘J / Ctrl J, the top bar's Ask AI, or `openAsk()`): Hỏi đáp beside the page, told what the
 * page shows. Mounted once in the app shell. Absent without a connected AI or with AI left out of the deployment; on
 * Hỏi đáp itself the shortcut only puts the cursor in its composer.
 */
export function AskLauncher() {
  const ai = useAiEnabled();
  const on = useFeature("ai");
  const path = usePathname();
  const onAsk = path.startsWith("/app/ai/ask");
  const [open, setOpen] = useState(false);
  // Once opened it stays mounted while closed, so the conversation is still there when it opens again.
  const [mounted, setMounted] = useState(false);
  const [incoming, setIncoming] = useState<{ refs: AskContextRef[]; n: number } | null>(null);
  const usable = ai && on;

  useEffect(() => {
    if (!usable) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "j") return;
      e.preventDefault();
      if (onAsk) {
        document.querySelector<HTMLTextAreaElement>("[data-ask-input]")?.focus();
        return;
      }
      setMounted(true);
      setOpen((v) => !v);
    };
    const onOpen = (e: Event) => {
      if (onAsk) return;
      const refs = (e as CustomEvent<{ refs?: AskContextRef[] }>).detail?.refs ?? [];
      setMounted(true);
      setOpen(true);
      if (refs.length) setIncoming((x) => ({ refs, n: (x?.n ?? 0) + 1 }));
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_ASK_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_ASK_EVENT, onOpen);
    };
  }, [usable, onAsk]);

  // Going to Hỏi đáp closes the panel: the page is the same conversation list, with more room.
  useEffect(() => {
    if (onAsk) setOpen(false);
  }, [onAsk]);

  if (!usable || !mounted || onAsk) return null;
  return <AskPanel open={open} onClose={() => setOpen(false)} incoming={incoming} />;
}
