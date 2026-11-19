import { describe, expect, it } from "vitest";
import { boardText, checkSceneLimits, checkThumbnail, mergeScenes, normalizeScene, pruneTombstones, SceneError, type Scene, type SceneElement } from "./whiteboard-scene.js";
import { buildTemplate, TEMPLATES } from "./whiteboard-templates.js";

const el = (id: string, version: number, extra: Partial<SceneElement> = {}): SceneElement => ({ id, type: "rectangle", version, versionNonce: 100, x: 0, y: 0, ...extra });
const scene = (...elements: SceneElement[]): Scene => ({ elements, appState: {}, files: {} });
const ids = (s: Scene) => s.elements.map((e) => `${e.id}@${e.version}${e.isDeleted ? "x" : ""}`);

describe("mergeScenes", () => {
  it("keeps everyone's elements: the higher version wins per id, one-sided elements stay", () => {
    const stored = scene(el("a", 3), el("b", 1), el("c", 2));
    const incoming = scene(el("a", 2), el("b", 4), el("d", 1));
    const { scene: m, changed } = mergeScenes(stored, incoming);
    expect(changed).toBe(true);
    expect(ids(m).sort()).toEqual(["a@3", "b@4", "c@2", "d@1"]);
  });

  it("breaks a version tie by the lower versionNonce, the same copy Excalidraw clients keep", () => {
    const stored = scene(el("a", 5, { versionNonce: 900, text: "server" }));
    expect(mergeScenes(stored, scene(el("a", 5, { versionNonce: 100, text: "lower" }))).scene.elements[0]!.text).toBe("lower");
    expect(mergeScenes(stored, scene(el("a", 5, { versionNonce: 999, text: "higher" }))).scene.elements[0]!.text).toBe("server");
  });

  it("merges deletions like edits: a newer tombstone wins, an older one does not resurrect or delete", () => {
    const stored = scene(el("a", 3), el("b", 6));
    const { scene: m } = mergeScenes(stored, scene(el("a", 4, { isDeleted: true }), el("b", 5, { isDeleted: true })));
    expect(ids(m).sort()).toEqual(["a@4x", "b@6"]);
  });

  it("reports nothing changed for a save of what is already stored", () => {
    const stored = scene(el("a", 3), el("b", 1));
    expect(mergeScenes(stored, scene(el("a", 3), el("b", 1))).changed).toBe(false);
    expect(mergeScenes(stored, scene(el("a", 2))).changed).toBe(false);
    expect(mergeScenes(stored, { ...scene(), appState: { gridModeEnabled: true } }).changed).toBe(true);
  });

  it("orders by fractional index when every element has one", () => {
    const stored = scene(el("b", 1, { index: "a1" }));
    const { scene: m } = mergeScenes(stored, scene(el("c", 1, { index: "a2" }), el("a", 1, { index: "a0" })));
    expect(m.elements.map((e) => e.id)).toEqual(["a", "b", "c"]);
  });

  it("unions the files map", () => {
    const stored: Scene = { ...scene(), files: { f1: { id: "f1", mimeType: "image/png", fileId: "01JAAAAAAAAAAAAAAAAAAAAAAA" } } };
    const m = mergeScenes(stored, { ...scene(), files: { f2: { id: "f2", mimeType: "image/png", fileId: "01JBBBBBBBBBBBBBBBBBBBBBBB" } } });
    expect(Object.keys(m.scene.files).sort()).toEqual(["f1", "f2"]);
  });
});

describe("normalizeScene", () => {
  it("drops image data URLs and app state the board does not keep", () => {
    const s = normalizeScene({
      elements: [el("a", 1)],
      appState: { viewBackgroundColor: "#ffffff", zoom: { value: 2 }, collaborators: {} },
      files: { f1: { id: "f1", mimeType: "image/png", fileId: "01JAAAAAAAAAAAAAAAAAAAAAAA", dataURL: "data:image/png;base64,AAAA" } },
    });
    expect(s.appState).toEqual({ viewBackgroundColor: "#ffffff" });
    expect(s.files.f1).toEqual({ id: "f1", mimeType: "image/png", fileId: "01JAAAAAAAAAAAAAAAAAAAAAAA" });
  });

  it("refuses elements without an id or version, and images not uploaded first", () => {
    expect(() => normalizeScene({ elements: [{ type: "rectangle", version: 1, versionNonce: 1 }] })).toThrow(SceneError);
    expect(() => normalizeScene({ elements: [{ id: "a", type: "rectangle", version: "1", versionNonce: 1 }] })).toThrow(/version/);
    expect(() => normalizeScene({ elements: [], files: { f: { id: "f", mimeType: "image/png", dataURL: "data:" } } })).toThrow(/fileId/);
    expect(() => normalizeScene({ elements: "nope" })).toThrow(SceneError);
  });

  it("keeps the newer copy when one save repeats an id", () => {
    expect(ids(normalizeScene({ elements: [el("a", 1), el("a", 3), el("a", 2)] }))).toEqual(["a@3"]);
  });
});

describe("limits", () => {
  it("caps live elements but not tombstones, and prunes the oldest tombstones", () => {
    const many = Array.from({ length: 5001 }, (_, i) => el(`e${i}`, 1));
    expect(() => checkSceneLimits(scene(...many))).toThrow(/at most 5000/);
    const dead = Array.from({ length: 10 }, (_, i) => el(`d${i}`, 2, { isDeleted: true, updated: i }));
    const kept = pruneTombstones([el("live", 1), ...dead], 3);
    expect(kept.map((e) => e.id)).toEqual(["live", "d7", "d8", "d9"]);
  });

  it("refuses scenes over 5 MB", () => {
    expect(() => checkSceneLimits(scene(el("big", 1, { text: "x".repeat(5 * 1024 * 1024) })))).toThrow(/too large/);
  });

  it("accepts an SVG thumbnail and refuses active content", () => {
    expect(checkThumbnail('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>')).toMatch(/^<svg/);
    expect(checkThumbnail('<?xml version="1.0"?>\n<svg viewBox="0 0 1 1"></svg>')).toMatch(/<svg/);
    expect(() => checkThumbnail("<svg><script>alert(1)</script></svg>")).toThrow(/active/);
    expect(() => checkThumbnail('<svg><rect onload="x()"/></svg>')).toThrow(/active/);
    expect(() => checkThumbnail("<html></html>")).toThrow(/SVG/);
    expect(() => checkThumbnail(`<svg>${"x".repeat(210 * 1024)}</svg>`)).toThrow(/too large/);
  });
});

describe("boardText", () => {
  it("finds stickies (filled shape with bound text, or our sticky marker) and reads labels in reading order", () => {
    const s = scene(
      el("head", 1, { type: "text", text: "Went well", x: 0, y: 0 }),
      el("n1", 1, { backgroundColor: "#FEF3C7", boundElements: [{ type: "text", id: "t1" }], x: 0, y: 100 }),
      el("t1", 1, { type: "text", text: "Fast\nreviews", originalText: "Fast reviews", containerId: "n1", x: 10, y: 110 }),
      el("n2", 1, { backgroundColor: "#ECFDF5", customData: { sticky: true }, x: 300, y: 100 }),
      el("outline", 1, { backgroundColor: "transparent", boundElements: [{ type: "text", id: "t2" }], x: 0, y: 400 }),
      el("t2", 1, { type: "text", text: "Step", containerId: "outline", x: 0, y: 400 }),
      el("gone", 2, { type: "text", text: "deleted", isDeleted: true, x: 0, y: 0 }),
    );
    const t = boardText(s);
    expect(t.stickies.map((x) => [x.elementId, x.text])).toEqual([
      ["n1", "Fast reviews"],
      ["n2", ""],
    ]);
    expect(t.labels.map((l) => l.text)).toEqual(["Went well", "Step"]);
    expect(t.text).toBe("Went well\nFast reviews\nStep");
  });
});

describe("templates", () => {
  it.each(TEMPLATES)("%s builds a valid scene in both languages", (key) => {
    for (const locale of ["vi", "en"] as const) {
      const s = normalizeScene(buildTemplate(key, locale));
      checkSceneLimits(s);
      // Indices increase, so the editor keeps the order without re-indexing.
      const idx = s.elements.map((e) => e.index as string);
      expect([...idx].sort()).toEqual(idx);
      expect(new Set(s.elements.map((e) => e.id)).size).toBe(s.elements.length);
      // Bound text points at its container and back.
      for (const e of s.elements.filter((x) => x.containerId)) {
        const c = s.elements.find((x) => x.id === e.containerId)!;
        expect((c.boundElements as { id: string }[]).some((b) => b.id === e.id)).toBe(true);
      }
    }
  });

  it("speaks the creator's language", () => {
    expect(boardText(buildTemplate("retro", "en")).text).toBe("Went well\nTo improve\nActions");
    expect(boardText(buildTemplate("kanban", "vi")).labels.map((l) => l.text)).toEqual(["Cần làm", "Đang làm", "Xong"]);
    expect(boardText(buildTemplate("blank", "vi")).text).toBe("");
    // The brainstorm topic is outlined, not a sticky; its idea notes are.
    expect(boardText(buildTemplate("brainstorm", "en")).stickies).toHaveLength(6);
  });

  it("column headings read clearly and the columns stay in the background", () => {
    const els = buildTemplate("retro", "en").elements;
    const heads = els.filter((e) => e.type === "text");
    expect(heads.map((h) => h.fontSize)).toEqual([28, 28, 28]);
    // Locked: a click or select-all on the board picks the notes, not the columns behind them.
    expect(els.every((e) => e.locked === true)).toBe(true);
    expect(buildTemplate("brainstorm", "en").elements.some((e) => e.locked)).toBe(false);
  });
});
