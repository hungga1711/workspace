import { describe, expect, it } from "vitest";
import { makeT } from "@/lib/i18n/dicts";
import {
  TRAIL_GROUPS,
  TRAIL_MODULES,
  actionLabel,
  changeList,
  filterFromParams,
  filterHref,
  groupLabel,
  headlineChange,
  humanize,
  moduleLabel,
  trailQuery,
  type TrailEntry,
} from "./audit";

const NOW = Date.parse("2026-11-05T12:00:00Z");

describe("filterFromParams", () => {
  it("keeps a well-formed filter and defaults to the last 30 days", () => {
    const f = filterFromParams({ actor: "u1", actorType: "user", module: "work", action: "work.task.", outcome: "denied", q: " T-142 " });
    expect(f).toEqual({ range: "30", actor: "u1", actorType: "user", module: "work", action: "work.task.", outcome: "denied", q: "T-142" });
  });

  it("drops anything malformed (a hand-edited URL never errors)", () => {
    const f = filterFromParams({ range: "9999", module: "billing", action: "DROP TABLE", outcome: "maybe", requestId: "x", from: "2026-01-01" });
    expect(f).toEqual({ range: "30" });
  });

  it("reads custom days only with the custom range", () => {
    expect(filterFromParams({ range: "custom", from: "2026-11-01", to: "2026-11-03" })).toEqual({ range: "custom", from: "2026-11-01", to: "2026-11-03" });
    expect(filterFromParams({ range: "7", from: "2026-11-01" })).toEqual({ range: "7" });
  });
});

describe("trailQuery", () => {
  it("turns the period into `from` and passes the filters", () => {
    const q = trailQuery({ range: "7", actor: "u1", targetType: "task", targetId: "t1" }, NOW);
    expect(q.get("from")).toBe("2026-10-29T12:00:00.000Z");
    expect(q.get("actor")).toBe("u1");
    expect(q.get("targetId")).toBe("t1");
    expect(q.has("to")).toBe(false);
  });

  it("has no lower bound for all time, and whole days for a custom period", () => {
    expect(trailQuery({ range: "all" }, NOW).has("from")).toBe(false);
    const q = trailQuery({ range: "custom", from: "2026-11-01", to: "2026-11-03" }, NOW);
    expect(q.get("from")).toBe("2026-11-01T00:00:00.000Z");
    expect(q.get("to")).toBe("2026-11-04T00:00:00.000Z");
  });
});

describe("filterHref", () => {
  it("adds a trace filter and keeps the period", () => {
    expect(filterHref({ range: "7" }, { targetType: "task", targetId: "t1" })).toBe("/admin/workspace/audit?range=7&targetType=task&targetId=t1");
  });
  it("removes a filter set to undefined and leaves the default period out of the URL", () => {
    expect(filterHref({ range: "30", actor: "u1", actorType: "user" }, { actor: undefined, actorType: undefined })).toBe("/admin/workspace/audit");
  });
});

describe("labels", () => {
  it("labels known actions in both languages, older admin actions through their old label", () => {
    for (const locale of ["en", "vi"] as const) {
      const tx = makeT(locale);
      for (const code of ["work.task.status_changed", "identity.auth.sign_in_failed", "chat.channel.archived", "identity.member.invite", "platform.webhook.create"])
        expect(actionLabel(tx, code), `${locale} ${code}`).not.toMatch(/^labels\.|_/);
      for (const g of TRAIL_GROUPS) expect(groupLabel(tx, g), `${locale} ${g}`).not.toMatch(/^labels\./);
      for (const m of TRAIL_MODULES) expect(moduleLabel(tx, m)).not.toMatch(/^labels\./);
    }
  });

  it("falls back to the code in words for an action it does not know", () => {
    expect(actionLabel(makeT("en"), "work.widget.frobbed_twice")).toBe("widget frobbed twice");
    expect(humanize("x")).toBe("x");
  });
});

describe("changes", () => {
  const entry = (changes: Record<string, unknown>): TrailEntry => ({
    id: "1",
    at: "2026-11-05T10:00:00Z",
    actorType: "user",
    actorId: "u1",
    via: "session",
    ip: null,
    userAgent: null,
    module: "work",
    action: "work.task.status_changed",
    targetType: "task",
    targetId: "t1",
    targetLabel: "T-142 · Báo giá",
    outcome: "success",
    requestId: null,
    changes,
    meta: {},
  });

  it("reads set values, private markers and reader lists", () => {
    expect(changeList({ status: { from: "todo", to: "in_progress" }, description: { changed: true }, sharedWith: { added: ["u2"], removed: [] } })).toEqual([
      { field: "status", kind: "set", from: "todo", to: "in_progress" },
      { field: "description", kind: "private" },
      { field: "sharedWith", kind: "members", added: ["u2"], removed: [] },
    ]);
  });

  it("puts a lone change in the sentence, never a private one", () => {
    expect(headlineChange(entry({ status: { from: "todo", to: "done" } }))).toEqual({ field: "status", kind: "set", from: "todo", to: "done" });
    expect(headlineChange(entry({ description: { changed: true } }))).toBeNull();
    expect(headlineChange(entry({ status: { from: "a", to: "b" }, dueAt: { from: null, to: "x" } }))).toBeNull();
  });
});
