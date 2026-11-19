import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { seedUpdate } from "./collab";
import type { SceneElement } from "./types";

const el = (id: string, version = 1): SceneElement => ({ id, type: "rectangle", version, versionNonce: 1, isDeleted: false, x: 0, y: 0, width: 10, height: 10 });

describe("whiteboard room seed", () => {
  it("holds the saved scene as two maps", () => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, seedUpdate([el("a"), el("b", 3)], [{ id: "f1", mimeType: "image/png", fileId: "F1" }]));
    expect([...doc.getMap<SceneElement>("elements").keys()].sort()).toEqual(["a", "b"]);
    expect(doc.getMap<SceneElement>("elements").get("b")?.version).toBe(3);
    expect(doc.getMap("files").get("f1")).toEqual({ id: "f1", mimeType: "image/png", fileId: "F1" });
  });

  it("converges when two people change one element", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const seed = seedUpdate([el("x")], []);
    Y.applyUpdate(a, seed);
    Y.applyUpdate(b, seed);
    a.getMap<SceneElement>("elements").set("x", el("x", 2));
    b.getMap<SceneElement>("elements").set("x", el("x", 3));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(a.getMap<SceneElement>("elements").get("x")).toEqual(b.getMap<SceneElement>("elements").get("x"));
  });
});
