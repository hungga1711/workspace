import type { ReactNode } from "react";

// Building blocks for the architecture diagrams: inline SVG so every colour comes from the theme (light or dark)
// and the text uses the site's own font. Coordinates are hand-placed per diagram; keep labels short enough for
// their boxes (about 6.4px per character at 11px).

const TITLE = 13;
const SMALL = 11;

export function Canvas({ w, h, title, children }: { w: number; h: number; title: string; children: ReactNode }) {
  return (
    <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={title} className="font-sans">
      <defs>
        <marker id="d-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M1 1 L9 5 L1 9 z" className="fill-fd-muted-foreground" />
        </marker>
        <marker id="d-arrow-accent" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M1 1 L9 5 L1 9 z" className="fill-signal" />
        </marker>
      </defs>
      {children}
    </svg>
  );
}

/** A labelled region. Dashed means optional. */
export function Group({ x, y, w, h, label, dashed }: { x: number; y: number; w: number; h: number; label: string; dashed?: boolean }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={14} className="fill-fd-muted/40 stroke-fd-border" strokeDasharray={dashed ? "4 4" : undefined} />
      <text x={x + 14} y={y + 18} fontSize={10} letterSpacing="0.06em" className="fill-fd-muted-foreground font-medium uppercase">
        {label}
      </text>
    </g>
  );
}

export function Node({
  x,
  y,
  w,
  h,
  title,
  sub,
  lines = [],
  accent,
  dashed,
}: {
  x: number;
  y: number;
  w: number;
  h?: number;
  title: string;
  sub?: string;
  lines?: string[];
  accent?: boolean;
  dashed?: boolean;
}) {
  const height = h ?? 40 + (sub ? 16 : 0) + lines.length * 15 + (sub || lines.length ? 2 : 0);
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={w}
        height={height}
        rx={10}
        className={accent ? "fill-signal-wash stroke-signal" : "fill-fd-card stroke-fd-border"}
        strokeWidth={accent ? 1.25 : 1}
        strokeDasharray={dashed ? "4 4" : undefined}
      />
      <text x={x + 14} y={y + 24} fontSize={TITLE} className="fill-fd-foreground font-medium">
        {title}
      </text>
      {sub ? (
        <text x={x + 14} y={y + 41} fontSize={SMALL} className="fill-fd-muted-foreground">
          {sub}
        </text>
      ) : null}
      {lines.map((l, i) => (
        <text key={l} x={x + 14} y={y + (sub ? 57 : 41) + i * 15} fontSize={SMALL} className="fill-fd-muted-foreground">
          {l}
        </text>
      ))}
    </g>
  );
}

/** Small chip, for lists such as the schemas of a database. */
export function Chip({ x, y, w, title, sub }: { x: number; y: number; w: number; title: string; sub?: string }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={sub ? 44 : 30} rx={8} className="fill-fd-card stroke-fd-border" />
      <text x={x + w / 2} y={y + 19} fontSize={12} textAnchor="middle" className="fill-fd-foreground font-medium">
        {title}
      </text>
      {sub ? (
        <text x={x + w / 2} y={y + 34} fontSize={9.5} textAnchor="middle" className="fill-fd-muted-foreground font-mono">
          {sub}
        </text>
      ) : null}
    </g>
  );
}

/** A straight or elbowed arrow through the given points, with an optional label drawn over the line. */
export function Arrow({
  points,
  label,
  at = 0.5,
  accent,
  dashed,
  both,
}: {
  points: [number, number][];
  label?: string;
  /** Where along the total length the label sits, 0 to 1. */
  at?: number;
  accent?: boolean;
  dashed?: boolean;
  both?: boolean;
}) {
  const d = points.map(([px, py], i) => `${i === 0 ? "M" : "L"}${px} ${py}`).join(" ");
  const marker = accent ? "url(#d-arrow-accent)" : "url(#d-arrow)";
  let lx = 0;
  let ly = 0;
  if (label) {
    const segs = points.slice(1).map((p, i) => ({ a: points[i], b: p, len: Math.hypot(p[0] - points[i][0], p[1] - points[i][1]) }));
    const total = segs.reduce((s, g) => s + g.len, 0);
    let t = at * total;
    for (const g of segs) {
      if (t <= g.len) {
        const k = g.len ? t / g.len : 0;
        lx = g.a[0] + (g.b[0] - g.a[0]) * k;
        ly = g.a[1] + (g.b[1] - g.a[1]) * k;
        break;
      }
      t -= g.len;
    }
  }
  const lw = label ? label.length * 6.4 + 14 : 0;
  return (
    <g>
      <path
        d={d}
        fill="none"
        className={accent ? "stroke-signal" : "stroke-fd-muted-foreground"}
        strokeWidth={accent ? 1.5 : 1.25}
        strokeDasharray={dashed ? "4 4" : undefined}
        markerEnd={marker}
        markerStart={both ? marker : undefined}
      />
      {label ? (
        <g>
          <rect x={lx - lw / 2} y={ly - 10} width={lw} height={20} rx={6} className="fill-fd-background stroke-fd-border" />
          <text x={lx} y={ly + 4} fontSize={SMALL} textAnchor="middle" className={accent ? "fill-signal-text" : "fill-fd-muted-foreground"}>
            {label}
          </text>
        </g>
      ) : null}
    </g>
  );
}

export function Note({ x, y, children }: { x: number; y: number; children: string }) {
  return (
    <text x={x} y={y} fontSize={SMALL} className="fill-fd-muted-foreground">
      {children}
    </text>
  );
}
