"use client";

/**
 * Feeds the pointer's position to whichever `spot` card it is over (the landing page's Spotlight): one listener for a
 * whole page or section instead of one per card. Mouse only; touch never lights a card.
 */
export function SpotArea({ children, className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== "mouse") return;
    const el = (e.target as HTMLElement).closest<HTMLElement>(".spot");
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty("--mx", `${e.clientX - r.left}px`);
    el.style.setProperty("--my", `${e.clientY - r.top}px`);
  };
  return (
    <div {...rest} className={className} onPointerMove={onPointerMove}>
      {children}
    </div>
  );
}
