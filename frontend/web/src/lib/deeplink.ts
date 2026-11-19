"use client";

import { useSearchParams } from "next/navigation";
import { useState } from "react";

/**
 * `?new=<value>` opens a create form straight away (Home quick actions link here).
 * Closing it drops the parameter so a reload or Back does not reopen the form.
 */
export function useNewParam(value: string): [boolean, (open: boolean) => void] {
  const sp = useSearchParams();
  const [open, setOpen] = useState(sp.get("new") === value);
  const set = (next: boolean) => {
    setOpen(next);
    if (!next && typeof window !== "undefined") {
      const url = new URL(window.location.href);
      if (url.searchParams.get("new") === value) {
        url.searchParams.delete("new");
        window.history.replaceState(window.history.state, "", url);
      }
    }
  };
  return [open, set];
}
