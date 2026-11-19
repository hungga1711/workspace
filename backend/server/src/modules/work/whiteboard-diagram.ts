import { Builder, STICKY_COLORS } from "./whiteboard-templates.js";
import type { SceneElement } from "./whiteboard-scene.js";

/**
 * A diagram the assistant draws on a whiteboard: nodes and edges in, Excalidraw elements out, laid out
 * in layers so nobody has to drag boxes apart afterwards. Flows go top to bottom, an org chart too (manager above
 * reports), a mind map's ideas around its centre. The elements are the board's own (Builder): once drawn they are
 * edited like anything drawn by hand.
 */
export const DIAGRAM_KINDS = ["flow", "org", "mindmap"] as const;
export type DiagramKind = (typeof DIAGRAM_KINDS)[number];
export const NODE_SHAPES = ["box", "round", "decision", "note"] as const;
export interface DiagramNode {
  id: string;
  label: string;
  shape?: (typeof NODE_SHAPES)[number] | undefined;
}
export interface DiagramEdge {
  from: string;
  to: string;
  label?: string | undefined;
}
export interface Diagram {
  kind: DiagramKind;
  title?: string | undefined;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

const W = 220;
const H = 90;
const GAP_X = 60;
const GAP_Y = 110;

/**
 * Each node's layer: its longest distance from a node nothing points at (cycles broken by visiting order), so a flow
 * reads downwards and a loop back draws as an arrow going up. Unknown edge ends are ignored.
 */
export function layers(nodes: DiagramNode[], edges: DiagramEdge[]): Map<string, number> {
  const ids = new Set(nodes.map((n) => n.id));
  const out = new Map<string, string[]>();
  const indeg = new Map(nodes.map((n) => [n.id, 0]));
  for (const e of edges) {
    if (!ids.has(e.from) || !ids.has(e.to) || e.from === e.to) continue;
    out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }
  const layer = new Map<string, number>();
  // Depth-first from each root, keeping only edges that do not close a cycle (on the current path).
  const visit = (id: string, depth: number, path: Set<string>) => {
    if ((layer.get(id) ?? -1) >= depth) return;
    layer.set(id, depth);
    path.add(id);
    for (const next of out.get(id) ?? []) if (!path.has(next)) visit(next, depth + 1, path);
    path.delete(id);
  };
  const roots = nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0);
  for (const r of roots.length ? roots : nodes.slice(0, 1)) visit(r.id, 0, new Set());
  // Whatever only a cycle reaches starts its own column at the top.
  for (const n of nodes) if (!layer.has(n.id)) visit(n.id, 0, new Set());
  return layer;
}

/** Top-left corner of each node, relative to the diagram's origin. */
export function layout(d: Pick<Diagram, "kind" | "nodes" | "edges">): Map<string, { x: number; y: number }> {
  const pos = new Map<string, { x: number; y: number }>();
  if (d.kind === "mindmap" && d.nodes.length) {
    // The first node is the centre; the rest go round it, one ring per layer.
    const L = layers(d.nodes, d.edges);
    const centre = d.nodes[0]!;
    pos.set(centre.id, { x: 0, y: 0 });
    const rings = new Map<number, DiagramNode[]>();
    for (const n of d.nodes.slice(1)) {
      const r = Math.max(1, L.get(n.id) ?? 1);
      rings.set(r, [...(rings.get(r) ?? []), n]);
    }
    for (const [r, ring] of rings)
      ring.forEach((n, i) => {
        const a = (2 * Math.PI * i) / ring.length - Math.PI / 2;
        pos.set(n.id, { x: Math.round(Math.cos(a) * r * (W + GAP_X) * 1.3), y: Math.round(Math.sin(a) * r * (H + GAP_Y) * 1.6) });
      });
    return pos;
  }
  const L = layers(d.nodes, d.edges);
  const rows = new Map<number, DiagramNode[]>();
  for (const n of d.nodes) rows.set(L.get(n.id) ?? 0, [...(rows.get(L.get(n.id) ?? 0) ?? []), n]);
  const widest = Math.max(1, ...[...rows.values()].map((r) => r.length));
  for (const [depth, row] of rows) {
    // Each row centred under the widest one.
    const offset = ((widest - row.length) * (W + GAP_X)) / 2;
    row.forEach((n, i) => pos.set(n.id, { x: Math.round(offset + i * (W + GAP_X)), y: depth * (H + GAP_Y) }));
  }
  return pos;
}

/** Where a diagram goes on a board that already has things on it: to the right of everything, top-aligned. */
export function originBeside(elements: SceneElement[]): { x: number; y: number } {
  const live = elements.filter((e) => !e.isDeleted && typeof e.x === "number" && typeof e.width === "number");
  if (!live.length) return { x: 0, y: 0 };
  const right = Math.max(...live.map((e) => (e.x as number) + Math.abs(e.width as number)));
  const top = Math.min(...live.map((e) => e.y as number));
  return { x: Math.round(right + 200), y: Math.round(top) };
}

/** The diagram's elements at `origin`, with a title above it when given. */
export function buildDiagram(d: Diagram, origin: { x: number; y: number }): SceneElement[] {
  const b = new Builder();
  const pos = layout(d);
  const top = d.title ? 60 : 0;
  if (d.title) b.text(origin.x, origin.y, d.title, { size: 28 });
  const shapes = new Map<string, SceneElement>();
  d.nodes.forEach((n, i) => {
    const p = pos.get(n.id) ?? { x: 0, y: 0 };
    const x = origin.x + p.x;
    const y = origin.y + top + p.y;
    const shape = n.shape ?? (d.kind === "org" ? "box" : "box");
    if (shape === "note") shapes.set(n.id, b.sticky(x, y, n.label, STICKY_COLORS[i % STICKY_COLORS.length]));
    else
      shapes.set(
        n.id,
        b.shape(shape === "decision" ? "diamond" : shape === "round" ? "ellipse" : "rectangle", x, y, shape === "decision" ? W + 20 : W, shape === "decision" ? H + 40 : H, {
          label: n.label,
          size: 18,
        }),
      );
  });
  for (const e of d.edges) {
    const from = shapes.get(e.from);
    const to = shapes.get(e.to);
    if (from && to && from !== to) b.arrow(from, to, e.label);
  }
  return b.elements;
}

const D = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/**
 * Fractional-index keys after `last` (the board's highest), in order: `last` with two more base-62 digits, never
 * ending in "0" (a valid key), so the new elements sit above everything already on the board.
 */
export function indicesAfter(last: string | null, n: number): string[] {
  if (!last) return Array.from({ length: n }, (_, i) => (i < 62 ? `a${D[i]}` : `b${D[Math.floor((i - 62) / 62)]}${D[(i - 62) % 62]}`));
  return Array.from({ length: n }, (_, i) => `${last}${D[1 + Math.floor(i / 61)]}${D[1 + (i % 61)]}`);
}

/** The diagram's elements placed beside what `existing` already holds, indexed above it. */
export function diagramFor(d: Diagram, existing: SceneElement[]): SceneElement[] {
  const els = buildDiagram(d, originBeside(existing));
  const last =
    existing
      .map((e) => e.index)
      .filter((x): x is string => typeof x === "string" && x.length > 0)
      .sort()
      .pop() ?? null;
  const keys = indicesAfter(last, els.length);
  return els.map((e, i) => ({ ...e, index: keys[i]! }));
}
