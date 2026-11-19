"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";

export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard can be blocked (insecure origin, permissions); the command stays selectable.
    }
  }

  return (
    <div className="flex h-10 w-full items-center gap-2 rounded-lg bg-panel pr-1 pl-3.5 font-mono text-[12.5px] text-ink shadow-[0_0_0_1px_var(--color-hair)]">
      <span className="shrink-0 text-ink-4 select-none" aria-hidden>
        $
      </span>
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap [mask-image:linear-gradient(to_right,black_calc(100%-3rem),transparent)] [scrollbar-width:none]">{command}</code>
      <button
        type="button"
        onClick={copy}
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-[var(--color-muted)] hover:text-ink"
        aria-label={copied ? "Copied" : "Copy the install command"}
      >
        {copied ? <Check className="size-4 text-ok" /> : <Copy className="size-4" />}
      </button>
    </div>
  );
}
