import { describe, expect, it } from "vitest";
import { deployFeatureOf } from "./gateway.js";

describe("routes of a feature left out at deploy time", () => {
  it("names the feature a route belongs to", () => {
    expect(deployFeatureOf("work", "/docs")).toBe("docs");
    expect(deployFeatureOf("work", "/docs/D-001/comments?x=1")).toBe("docs");
    expect(deployFeatureOf("work", "/docs-home")).toBe("docs");
    expect(deployFeatureOf("work", "/spaces/abc")).toBe("docs");
    expect(deployFeatureOf("work", "/drive/uploads")).toBe("docs");
    expect(deployFeatureOf("work", "/whiteboards/folders")).toBe("whiteboards");
    expect(deployFeatureOf("work", "/calendar/events?from=2026-11-01")).toBe("calendar");
    expect(deployFeatureOf("work", "/meetings/followups")).toBe("calendar");
    expect(deployFeatureOf("employee", "/attendance/check-in")).toBe("time");
    expect(deployFeatureOf("employee", "/leave/balances")).toBe("time");
    expect(deployFeatureOf("work", "/workflows")).toBe("ai");
    expect(deployFeatureOf("work", "/tasks/T-001/runs")).toBe("ai");
    expect(deployFeatureOf("work", "/agent-questions/open")).toBe("ai");
    expect(deployFeatureOf("ai", "/assistant/conversations")).toBe("ai");
    expect(deployFeatureOf("ai", "/oversight")).toBe("ai");
  });

  it("leaves chat, tasks and what they share alone", () => {
    expect(deployFeatureOf("chat", "/channels")).toBeNull();
    expect(deployFeatureOf("work", "/tasks")).toBeNull();
    expect(deployFeatureOf("work", "/tasks/T-001")).toBeNull();
    expect(deployFeatureOf("work", "/projects")).toBeNull();
    // Attachments, video rooms and holidays are used by tasks, chat and calls.
    expect(deployFeatureOf("work", "/files/uploads")).toBeNull();
    expect(deployFeatureOf("work", "/meet/rooms")).toBeNull();
    expect(deployFeatureOf("employee", "/holidays")).toBeNull();
    expect(deployFeatureOf("employee", "/me")).toBeNull();
    // The web reads the AI status to decide what to show; it answers "off".
    expect(deployFeatureOf("ai", "/status")).toBeNull();
    expect(deployFeatureOf("ai", "/health")).toBeNull();
    // A name that only starts like a feature's.
    expect(deployFeatureOf("work", "/docsearch")).toBeNull();
    expect(deployFeatureOf("identity", "/docs")).toBeNull();
  });

  it("is not fooled by another spelling of the same route", () => {
    expect(deployFeatureOf("work", "/Whiteboards/")).toBe("whiteboards");
    expect(deployFeatureOf("work", "/docs%2Fabc")).toBe("docs");
    expect(deployFeatureOf("work", "//calendar//events")).toBe("calendar");
    expect(deployFeatureOf("ai", "/STATUS/x")).toBe("ai");
  });
});
