import { describe, expect, it } from "vitest";
import type { Principal } from "@workspace/shared";
import { canEditDoc, canReadDoc, noNul, type DocRow } from "./documents.js";

const who = (id: string, grants: Principal["grants"] = []): Principal => ({ type: "user", id, teamIds: [], departmentId: null, grants });
const everyone: Principal["grants"] = [
  { permission: "document.read", scope: "WORKSPACE" },
  { permission: "document.create", scope: "WORKSPACE" },
];

const page = (over: Partial<DocRow> = {}): DocRow => ({
  id: "d1",
  code: "D-1",
  title: "",
  owner_id: "lily",
  project_id: null,
  visibility: "space",
  shared_with: [],
  current_version: 1,
  updated_at: new Date(),
  space_id: "s1",
  parent_id: null,
  position: 1,
  labels: [],
  emoji: "",
  format: "html",
  last_editor_id: null,
  published: true,
  space_visibility: "workspace",
  space_members: [],
  space_owner: "lily",
  ...over,
});

describe("documents: NUL guard", () => {
  it("drops U+0000 from every string in a body, nested too", () => {
    const body = { title: "A\u0000B", content: '<p><span data-type="mention">\u0000Freya Ali</span></p>', labels: ["x\u0000"], baseVersion: 2, n: null };
    expect(noNul(body)).toEqual({ title: "AB", content: '<p><span data-type="mention">Freya Ali</span></p>', labels: ["x"], baseVersion: 2, n: null });
  });

  it("leaves values without NUL as they are", () => {
    expect(noNul("Tiêu đề @Freya")).toBe("Tiêu đề @Freya");
    expect(noNul(undefined)).toBeUndefined();
  });
});

describe("documents: drafts", () => {
  it("shows a never-published page to its owner only", () => {
    const draft = page({ published: false });
    expect(canReadDoc(who("lily"), draft)).toBe(true);
    expect(canEditDoc(who("lily"), draft)).toBe(true);
    expect(canReadDoc(who("freya", everyone), draft)).toBe(false);
    expect(canEditDoc(who("freya", everyone), draft)).toBe(false);
    // Sharing a draft does not open it early either.
    expect(canReadDoc(who("freya"), { ...draft, shared_with: ["freya"] })).toBe(false);
  });

  it("opens the page to the space once published", () => {
    expect(canReadDoc(who("freya", everyone), page())).toBe(true);
  });
});
