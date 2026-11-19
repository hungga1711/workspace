"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Overlays render into <body>: a fixed element inside an ancestor with
 * backdrop-filter/transform (the sticky top bar) is positioned against that
 * ancestor instead of the viewport.
 */
export function Portal({ children }: { children: React.ReactNode }) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => setEl(document.body), []);
  return el ? createPortal(children, el) : null;
}
