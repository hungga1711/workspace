import { useId } from "react";
import { MARK } from "@/lib/brand-mark";
import { cx } from "@/lib/ui";

/**
 * The workspace mark (lib/brand-mark.ts). `tile` (default): the blue-to-violet cat w (mouth and nose) on the rounded
 * logo tile (white, dark in the dark theme), for the logo, sign-in and the sidebar; size it with `size-*` (square;
 * the tile's corners are 10/40 of its side). `plain`: the w alone in the current text colour, for the system avatar.
 */
export function BrandMark({ className, variant = "tile", title }: { className?: string; variant?: "tile" | "plain"; title?: string }) {
  const id = useId();
  const tile = variant === "tile";
  const paint = tile ? `url(#${id})` : "currentColor";
  const g = MARK.gradient;
  return (
    <svg aria-hidden={title ? undefined : true} role={title ? "img" : undefined} aria-label={title} viewBox="0 0 40 40" className={cx("inline-block size-6 shrink-0", className)}>
      {tile ? (
        <>
          <defs>
            <linearGradient id={id} gradientUnits="userSpaceOnUse" x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2}>
              <stop offset="0" className="[stop-color:var(--mark-from)]" />
              <stop offset="1" className="[stop-color:var(--mark-to)]" />
            </linearGradient>
          </defs>
          <rect width="40" height="40" rx="10" className="fill-logo-tile" />
          <rect x=".5" y=".5" width="39" height="39" rx="9.5" fill="none" className="stroke-logo-ring" />
        </>
      ) : null}
      <g fill="none" stroke={paint} strokeLinecap="round" strokeLinejoin="round">
        {MARK.strokes.map((x) => (
          <path key={x.d} d={x.d} strokeWidth={x.w} />
        ))}
      </g>
      {MARK.fills.map((x) => (
        <path key={x.d} d={x.d} fill={paint} stroke={paint} strokeWidth={0.8} strokeLinejoin="round" />
      ))}
    </svg>
  );
}

/** The name, set in the display face. */
export function Wordmark({ className }: { className?: string }) {
  return <span className={cx("font-display text-ink font-bold tracking-[-0.035em]", className)}>workspace</span>;
}
