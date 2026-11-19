import { INK, MUTED } from "./palette";
import type { SceneElement } from "./types";

/**
 * A template's small picture, drawn straight from its scene (the work module's template, as the board will get it):
 * shapes with their own fills, text as soft bars. Plain SVG, so the list and the picker never load the canvas.
 */
export function ScenePreview({ elements, className }: { elements: readonly SceneElement[]; className?: string }) {
  const els = elements.filter((e) => !e.isDeleted);
  if (!els.length) {
    return (
      <svg viewBox="0 0 160 100" className={className} aria-hidden="true">
        <rect x="20" y="16" width="120" height="68" rx="8" fill="none" stroke={MUTED} strokeOpacity=".35" strokeWidth="2" strokeDasharray="6 5" />
      </svg>
    );
  }
  const x0 = Math.min(...els.map((e) => e.x));
  const y0 = Math.min(...els.map((e) => e.y));
  const x1 = Math.max(...els.map((e) => e.x + Math.max(0, e.width)));
  const y1 = Math.max(...els.map((e) => e.y + Math.max(0, e.height)));
  const pad = Math.max(24, (x1 - x0) * 0.04);
  const stroke = (e: SceneElement) => (e.strokeColor && e.strokeColor !== "transparent" ? e.strokeColor : "none");
  const fill = (e: SceneElement) => (e.backgroundColor && e.backgroundColor !== "transparent" ? e.backgroundColor : "none");
  const sw = Math.max(2, (x1 - x0) / 300);
  return (
    <svg viewBox={`${x0 - pad} ${y0 - pad} ${x1 - x0 + 2 * pad} ${y1 - y0 + 2 * pad}`} className={className} aria-hidden="true" preserveAspectRatio="xMidYMid meet">
      {els.map((e) => {
        const common = { stroke: stroke(e), strokeWidth: sw, fill: fill(e) };
        switch (e.type) {
          case "rectangle":
          case "frame":
            return <rect key={e.id} x={e.x} y={e.y} width={e.width} height={e.height} rx={e.roundness ? Math.min(16, e.width / 8) : 0} {...common} />;
          case "ellipse":
            return <ellipse key={e.id} cx={e.x + e.width / 2} cy={e.y + e.height / 2} rx={e.width / 2} ry={e.height / 2} {...common} />;
          case "diamond":
            return (
              <path
                key={e.id}
                d={`M${e.x + e.width / 2} ${e.y}L${e.x + e.width} ${e.y + e.height / 2}L${e.x + e.width / 2} ${e.y + e.height}L${e.x} ${e.y + e.height / 2}Z`}
                {...common}
              />
            );
          case "arrow":
          case "line": {
            const pts = (e.points as [number, number][] | undefined) ?? [
              [0, 0],
              [e.width, e.height],
            ];
            return <polyline key={e.id} points={pts.map(([px, py]) => `${e.x + px},${e.y + py}`).join(" ")} fill="none" stroke={INK} strokeWidth={sw} />;
          }
          case "text": {
            // Text as a bar the width of the words (the font is not needed for a thumbnail).
            const h = Math.max(6, (e.height || 20) * 0.6);
            return <rect key={e.id} x={e.x} y={e.y + ((e.height || 20) - h) / 2} width={Math.max(h, e.width)} height={h} rx={h / 2} fill={MUTED} opacity=".4" />;
          }
          default:
            return null;
        }
      })}
    </svg>
  );
}
