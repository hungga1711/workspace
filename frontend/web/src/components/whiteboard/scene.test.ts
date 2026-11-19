import { describe, expect, it } from "vitest";
import { changedSince, clusterLayout, freeSlot, freeSlots, isSticky, mergeElements, newer, sceneText, snapshotElements, stickies, stickyTask, TOMBSTONE_MS } from "./scene";
import type { SceneElement } from "./types";

const el = (id: string, over: Partial<SceneElement> = {}): SceneElement => ({
  id,
  type: "rectangle",
  version: 1,
  versionNonce: 10,
  isDeleted: false,
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  ...over,
});
const text = (id: string, t: string, over: Partial<SceneElement> = {}) => el(id, { type: "text", text: t, originalText: t, ...over });

describe("merging scenes", () => {
  it("keeps the higher version, ties to the lower nonce, on every side alike", () => {
    expect(newer(el("a", { version: 3 }), el("a", { version: 2 })).version).toBe(3);
    const a = el("a", { version: 2, versionNonce: 5 });
    const b = el("a", { version: 2, versionNonce: 9 });
    expect(newer(a, b)).toBe(a);
    expect(newer(b, a)).toBe(a);
  });

  it("unions both sides in stacking order", () => {
    const local = [el("a", { index: "a1", version: 2 }), el("b", { index: "a3" })];
    const remote = [el("a", { index: "a1", version: 1 }), el("c", { index: "a2" }), el("b", { index: "a3", version: 4, isDeleted: true })];
    const m = mergeElements(local, remote);
    expect(m.map((e) => e.id)).toEqual(["a", "c", "b"]);
    expect(m[0]!.version).toBe(2);
    expect(m[2]!.isDeleted).toBe(true);
  });

  it("is the same whichever side merges", () => {
    const x = [el("a", { version: 2, versionNonce: 1, index: "a0" }), el("b", { index: "a1" })];
    const y = [el("a", { version: 2, versionNonce: 0, index: "a0" }), el("c", { index: "a2" })];
    expect(mergeElements(x, y)).toEqual(mergeElements(y, x));
  });
});

describe("collab diff", () => {
  it("sends only elements whose version moved", () => {
    const sent = new Map([
      ["a", 1],
      ["b", 2],
    ]);
    expect(changedSince(sent, [el("a"), el("b", { version: 3 }), el("c")]).map((e) => e.id)).toEqual(["b", "c"]);
  });
});

describe("snapshots", () => {
  it("drop tombstones older than a day", () => {
    const now = 10 * TOMBSTONE_MS;
    const out = snapshotElements([el("live"), el("fresh", { isDeleted: true, updated: now - 1000 }), el("old", { isDeleted: true, updated: now - TOMBSTONE_MS - 1 })], now);
    expect(out.map((e) => e.id)).toEqual(["live", "fresh"]);
  });
});

describe("text extraction", () => {
  it("reads every visible text top to bottom", () => {
    const els = [text("2", "Thứ hai", { y: 50 }), text("1", "Đầu tiên", { y: 0, x: 10 }), text("x", "đã xoá", { isDeleted: true }), text("e", "   "), el("r")];
    expect(sceneText(els)).toBe("Đầu tiên\nThứ hai");
  });
});

describe("stickies", () => {
  const ours = el("s1", { customData: { sticky: true }, backgroundColor: "#fef3c7", strokeColor: "transparent", boundElements: [{ id: "t1", type: "text" }] });
  const pasted = el("s2", { backgroundColor: "#ffec99", strokeColor: "transparent", boundElements: [{ id: "t2", type: "text" }] });
  const box = el("r", { backgroundColor: "#ffec99", strokeColor: "#1e1e1e", boundElements: [{ id: "t3", type: "text" }] });
  const empty = el("s3", { backgroundColor: "#ffec99", strokeColor: "transparent" });

  it("are filled, outline-free rectangles with text, or marked as ours", () => {
    expect(isSticky(ours)).toBe(true);
    expect(isSticky(pasted)).toBe(true);
    expect(isSticky(box)).toBe(false);
    expect(isSticky(empty)).toBe(false);
    expect(isSticky({ ...ours, isDeleted: true })).toBe(false);
    expect(isSticky({ ...ours, type: "ellipse" })).toBe(false);
  });

  it("come with their bound text", () => {
    const list = stickies([ours, pasted, box, text("t1", "Gọi khách hàng", { containerId: "s1" }), text("t2", "", { containerId: "s2" })]);
    expect(list.map((s) => [s.element.id, s.text])).toEqual([
      ["s1", "Gọi khách hàng"],
      ["s2", ""],
    ]);
  });

  it("become a task titled by their first line", () => {
    expect(stickyTask("  Gọi khách hàng  ")).toEqual({ title: "Gọi khách hàng" });
    expect(stickyTask("Gọi khách\n\nhỏi về giá")).toEqual({ title: "Gọi khách", description: "Gọi khách\nhỏi về giá" });
    expect(stickyTask(" \n ")).toBeNull();
    const long = "x".repeat(250);
    expect(stickyTask(long)!.title).toHaveLength(200);
    expect(stickyTask(long)!.description).toBe(long);
  });
});

describe("placing things", () => {
  const S = { width: 200, height: 200 };
  it("puts a note at the centre when it is free", () => {
    expect(freeSlot({ x: 100, y: 100 }, [], S)).toEqual({ x: 0, y: 0 });
  });

  it("moves to the next free cell, right first, then down, never on top of another", () => {
    const first = { x: 0, y: 0, ...S };
    expect(freeSlot({ x: 100, y: 100 }, [first], S)).toEqual({ x: 220, y: 0 });
    const right = { x: 220, y: 0, ...S };
    expect(freeSlot({ x: 100, y: 100 }, [first, right], S)).toEqual({ x: 0, y: 220 });
  });

  it("places several notes without overlap", () => {
    const spots = freeSlots(9, { x: 0, y: 0 }, [], S);
    for (let i = 0; i < spots.length; i++)
      for (let j = i + 1; j < spots.length; j++) {
        const a = spots[i]!;
        const b = spots[j]!;
        expect(Math.abs(a.x - b.x) >= 200 || Math.abs(a.y - b.y) >= 200).toBe(true);
      }
  });

  it("clusters groups into labelled frames, each note once", () => {
    const { frames, moves } = clusterLayout(
      [
        { title: "A", elementIds: ["1", "2"] },
        { title: "B", elementIds: ["3", "1", "4", "5", "6"] },
      ],
      { x: 0, y: 0 },
      100,
      10,
      20,
      40,
    );
    expect(frames.map((f) => [f.title, f.x, f.width])).toEqual([
      ["A", 0, 140],
      ["B", 220, 250],
    ]);
    expect(moves.get("1")).toEqual({ x: 20, y: 40 });
    expect(moves.get("2")).toEqual({ x: 20, y: 150 });
    // B has four notes left: two across.
    expect(moves.get("4")).toEqual({ x: 350, y: 40 });
    expect(moves.size).toBe(6);
  });
});
