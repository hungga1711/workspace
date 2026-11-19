"use client";

import { useId } from "react";

// The Workspace mark, the same drawing as frontend/web/src/lib/brand-mark.ts: the cat w (a thick soft w with a
// triangle nose, blue to violet) on a white tile with a 12% hairline. The tile stays white on the dark landing page
// too, so the logo looks exactly as it does in the app. The gradient id is unique per instance: the docs shell
// renders the title twice (desktop sidebar, phone header) and a gradient defined inside a hidden copy does not paint.
export function Mark({ className = "size-7" }: { className?: string }) {
  const id = useId();
  return (
    <svg viewBox="0 0 40 40" className={className} aria-hidden="true">
      <defs>
        <linearGradient id={id} gradientUnits="userSpaceOnUse" x1="6" y1="8" x2="34" y2="32">
          <stop offset="0" stopColor="#3b6bff" />
          <stop offset="1" stopColor="#8b5cf6" />
        </linearGradient>
      </defs>
      <rect width="40" height="40" rx="10" fill="#fff" />
      <rect x="0.5" y="0.5" width="39" height="39" rx="9.5" fill="none" stroke="#18181b" strokeOpacity="0.12" />
      <path d="M10 17 C11.5 30 16 30 17.6 22.5 C18.6 18 21.4 18 22.4 22.5 C24 30 28.5 30 30 17" fill="none" stroke={`url(#${id})`} strokeWidth="4.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M18.2 12.6 H21.8 L20 15.2z" fill={`url(#${id})`} stroke={`url(#${id})`} strokeWidth="0.8" strokeLinejoin="round" />
    </svg>
  );
}

export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <Mark className="size-6" />
      <span className="text-[1.0625rem] font-semibold tracking-[-0.035em]">Workspace</span>
    </span>
  );
}
