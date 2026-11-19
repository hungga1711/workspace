import { describe, expect, it } from "vitest";
import { ASK_DRAG_TYPE, mayBeRef, refFromDrop, refFromPath, refFromUrl, titleLabel } from "./ask-context";

const ID = "01M7AAAAAAAAAAAAAAAAAAAAAA";
const ORIGIN = "https://work.example.com";
const drop = (data: Record<string, string>) => ({ types: Object.keys(data), getData: (k: string) => data[k] ?? "" });

describe("the ask panel's context", () => {
  it("names the screen from the tab title", () => {
    expect(titleLabel("T-041 Launch post · workspace")).toBe("T-041 Launch post");
    expect(titleLabel("Plan · Q4 · workspace")).toBe("Plan · Q4");
    expect(titleLabel("workspace")).toBe("workspace");
  });

  it("knows the records the app's screens show", () => {
    expect(refFromPath("/app/work/tasks/T-041", "", "T-041 Launch")).toEqual({ kind: "task", id: "T-041", label: "T-041 Launch", code: "T-041" });
    expect(refFromPath(`/app/work/docs/${ID}`, "", "Plan")).toEqual({ kind: "document", id: ID, label: "Plan", code: null });
    expect(refFromPath("/app/work/projects/WEB-3", "", "Web")).toMatchObject({ kind: "project", id: "WEB-3" });
    expect(refFromPath("/app/work/meetings/H-012-3", "", "Weekly")).toMatchObject({ kind: "meeting", id: "H-012-3" });
    expect(refFromPath("/app/work/people/u-lan", "", "Lan")).toEqual({ kind: "person", id: "u-lan", label: "Lan" });
    expect(refFromPath("/app/me/people", "?u=u-lan", "Lan")).toMatchObject({ kind: "person", id: "u-lan" });
    expect(refFromPath("/app/ai/progress", "", "AI")).toEqual({ kind: "report", id: "progress", label: "AI" });
    expect(refFromPath(`/app/chat/${ID}`, "", "#launch")).toEqual({ kind: "channel", id: ID, label: "#launch" });
    expect(refFromPath(`/app/chat/${ID}`, `?thread=${ID}`, "#launch")).toMatchObject({ thread: ID });
    expect(refFromPath(`/app/chat/m/${ID}`, "", "")).toEqual({ kind: "message", id: ID, label: ID });
  });

  it("leaves screens without one record alone", () => {
    for (const path of ["/app/home", "/app/work/tasks", "/app/work/docs/new", "/app/chat", "/app/ai/ask", "/login", "/app/work/tasks/hello world"])
      expect(refFromPath(path, "", "x")).toBeNull();
  });

  it("turns a pasted or dropped link of this app into a chip, and nothing else", () => {
    expect(refFromUrl(`${ORIGIN}/app/work/tasks/T-7?tab=comments`, ORIGIN)).toEqual({ kind: "task", id: "T-7", label: "T-7", code: "T-7" });
    expect(refFromUrl("/app/work/tasks/T-7", ORIGIN)).toMatchObject({ kind: "task" });
    expect(refFromUrl("https://evil.example.com/app/work/tasks/T-7", ORIGIN)).toBeNull();
    expect(refFromUrl("see /app/work/tasks/T-7 please", ORIGIN)).toBeNull();
    expect(refFromUrl("not a url", ORIGIN)).toBeNull();
  });

  it("reads an app item or a link from a drop, never marking it as the screen", () => {
    const item = JSON.stringify({ kind: "message", id: ID, label: "Ship it?", page: true });
    expect(refFromDrop(drop({ [ASK_DRAG_TYPE]: item }), ORIGIN)).toEqual({ kind: "message", id: ID, label: "Ship it?", page: false });
    expect(refFromDrop(drop({ "text/uri-list": `# comment\n${ORIGIN}/app/work/docs/D-2` }), ORIGIN)).toMatchObject({ kind: "document", id: "D-2" });
    expect(refFromDrop(drop({ [ASK_DRAG_TYPE]: "{broken" }), ORIGIN)).toBeNull();
    expect(refFromDrop(drop({ "text/plain": "hello" }), ORIGIN)).toBeNull();
    expect(mayBeRef(["Files"])).toBe(false);
    expect(mayBeRef(["text/uri-list"])).toBe(true);
  });
});
