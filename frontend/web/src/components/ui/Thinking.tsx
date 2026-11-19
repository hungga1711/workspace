"use client";

import { useEffect, useState } from "react";

/** An AI answer on its way: three pulsing dots and a line, which changes to `longLabel` after 8 seconds. */
export function Thinking({ label, longLabel, className }: { label: string; longLabel: string; className?: string }) {
  const [long, setLong] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setLong(true), 8000);
    return () => clearTimeout(id);
  }, []);
  return (
    <span className="text-ink-2 inline-flex items-center gap-2" role="status">
      <span className="inline-flex gap-1" aria-hidden="true">
        <span className="bg-ink-2 size-1.5 animate-pulse rounded-full" />
        <span className="bg-ink-2 size-1.5 animate-pulse rounded-full [animation-delay:200ms]" />
        <span className="bg-ink-2 size-1.5 animate-pulse rounded-full [animation-delay:400ms]" />
      </span>
      <span className={className ?? "animate-rise text-sm"} key={long ? "long" : "short"}>
        {long ? longLabel : label}
      </span>
    </span>
  );
}
