"use client";

import { useState } from "react";
import { CheckIcon, CopyIcon } from "@/components/app/icons";

/** A fenced code block: the language over it and, where the caller gives labels, a copy button. */
export function CodeBlock({ code, lang, copy }: { code: string; lang: string; copy?: { label: string; done: string } | undefined }) {
  const [copied, setCopied] = useState(false);
  const bar = lang || copy;
  return (
    <div className="bg-hover my-3 overflow-hidden rounded-lg">
      {bar ? (
        <div className="text-ink-2 flex h-8 items-center gap-2 pl-3 pr-1 text-xs">
          <span className="flex-1 truncate font-mono">{lang}</span>
          {copy ? (
            <button
              type="button"
              aria-label={copied ? copy.done : copy.label}
              title={copied ? copy.done : copy.label}
              className="hover:bg-selected hover:text-ink grid size-7 place-items-center rounded-md transition-colors"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(code)
                  .then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  })
                  .catch(() => undefined);
              }}
            >
              {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
            </button>
          ) : null}
        </div>
      ) : null}
      <pre className={`m-0 overflow-x-auto px-3 font-mono text-[13px]/[1.6] ${bar ? "pb-3" : "py-3"}`}>
        <code>{code}</code>
      </pre>
    </div>
  );
}
