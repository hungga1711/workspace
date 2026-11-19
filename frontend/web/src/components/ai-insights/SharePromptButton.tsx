"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { useT } from "@/lib/i18n/client";
import { btnGhost, btnSm, cx } from "@/lib/ui";

// The dialog (fetch, redacted draft, form) loads on the first click, never with Của tôi › AI.
const SharePromptDialog = dynamic(() => import("./SharePromptDialog").then((m) => m.SharePromptDialog));

/** "Chia sẻ prompt này" on one of my own conversations: opens the redacted draft for me to check and share. */
export function SharePromptButton({ conversationId, className }: { conversationId: string; className?: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={cx(btnGhost, btnSm, "text-ink-2 justify-self-start", className)} onClick={() => setOpen(true)}>
        {t("aiInsights.share.button")}
      </button>
      {open ? <SharePromptDialog conversationId={conversationId} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
