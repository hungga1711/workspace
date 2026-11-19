import { describe, expect, it } from "vitest";
import { buildDiagram, diagramFor, indicesAfter, layers, layout, originBeside } from "./whiteboard-diagram.js";
import { normalizeScene, type SceneElement } from "./whiteboard-scene.js";

const flow = {
  kind: "flow" as const,
  nodes: [
    { id: "s", label: "Start", shape: "round" as const },
    { id: "a", label: "Fill form" },
    { id: "d", label: "OK?", shape: "decision" as const },
    { id: "e", label: "End", shape: "round" as const },
  ],
  edges: [
    { from: "s", to: "a" },
    { from: "a", to: "d" },
    { from: "d", to: "e", label: "Yes" },
    { from: "d", to: "a", label: "No" },
  ],
};

describe("whiteboard diagrams", () => {
  it("puts each node one layer below what points at it, a loop back included", () => {
    expect(Object.fromEntries(layers(flow.nodes, flow.edges))).toEqual({ s: 0, a: 1, d: 2, e: 3 });
  });
  it("lays out an org chart with reports side by side under their manager", () => {
    const p = layout({
      kind: "org",
      nodes: [
        { id: "ceo", label: "CEO" },
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
      edges: [
        { from: "ceo", to: "a" },
        { from: "ceo", to: "b" },
      ],
    });
    expect(p.get("a")!.y).toBe(p.get("b")!.y);
    expect(p.get("a")!.y).toBeGreaterThan(p.get("ceo")!.y);
    expect(p.get("b")!.x).toBeGreaterThan(p.get("a")!.x);
  });
  it("builds a valid scene: shapes with bound labels and bound arrows", () => {
    const els = buildDiagram({ ...flow, title: "Signup" }, { x: 0, y: 0 });
    expect(() => normalizeScene({ elements: els })).not.toThrow();
    expect(els.filter((e) => e.type === "arrow")).toHaveLength(4);
    expect(els.filter((e) => e.type === "diamond")).toHaveLength(1);
    expect(els.find((e) => e.type === "text" && e.text === "Signup")).toBeTruthy();
  });
  it("goes to the right of what is on the board, indexed above it", () => {
    const existing = [{ id: "x", type: "rectangle", x: 100, y: 50, width: 300, height: 100, version: 1, versionNonce: 1, index: "a5" }] as SceneElement[];
    expect(originBeside(existing)).toEqual({ x: 600, y: 50 });
    const els = diagramFor(flow, existing);
    expect(Math.min(...els.map((e) => e.x as number))).toBeGreaterThanOrEqual(600);
    const idx = els.map((e) => e.index as string);
    expect(idx.every((k) => k > "a5")).toBe(true);
    expect([...idx].sort()).toEqual(idx);
    expect(idx.some((k) => k.endsWith("0"))).toBe(false);
  });
  it("makes increasing keys past 61 items", () => {
    const k = indicesAfter("a1", 130);
    expect(new Set(k).size).toBe(130);
    expect([...k].sort()).toEqual(k);
  });
});
