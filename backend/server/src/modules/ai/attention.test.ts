import { describe, expect, it } from "vitest";
import { connectionItems, modelItems, serverItems, type ConnectionRow, type ServerRow } from "./attention.js";

const at = new Date("2026-11-13T08:00:00Z");
const conn = (o: Partial<ConnectionRow>): ConnectionRow => ({
  id: "c1",
  name: "OpenAI",
  mode: "key",
  is_default: false,
  test_ok: true,
  test_error: null,
  tested_at: at,
  created_at: at,
  created_by: "minh",
  ...o,
});
const server = (o: Partial<ServerRow>): ServerRow => ({
  id: "s1",
  name: "GitHub",
  auth: "header",
  oauth_per_user: false,
  test_ok: true,
  test_error: null,
  tested_at: at,
  tools_at: at,
  created_at: at,
  created_by: "minh",
  has_token: false,
  token_expires_at: null,
  token_renews: false,
  failed: 0,
  failed_auth: 0,
  failed_since: null,
  ...o,
});

describe("AI connections that need an admin", () => {
  it("a connection whose last check passed is not listed", () => {
    expect(connectionItems([conn({})])).toEqual([]);
  });
  it("a failed check is listed with its reason; the default connection is the serious one", () => {
    const items = connectionItems([conn({ test_ok: false, test_error: "401 invalid key" }), conn({ id: "c2", is_default: true, test_ok: false })]);
    expect(items).toMatchObject([
      { id: "ai.connection.failed:c1", severity: "warning", detail: "401 invalid key", since: at.toISOString(), ownerId: "minh" },
      { id: "ai.connection.failed:c2", severity: "broken" },
    ]);
    expect(items[1]).not.toHaveProperty("detail");
  });
  it("a connection nobody checked is unknown, never healthy", () => {
    expect(connectionItems([conn({ test_ok: null, tested_at: null })])).toMatchObject([{ kind: "ai.connection.unchecked", severity: "unknown" }]);
  });
  it("a person's own computer is not the admin's to fix", () => {
    expect(connectionItems([conn({ mode: "device", test_ok: false })])).toEqual([]);
  });
});

describe("outside tools that need an admin", () => {
  it("a company sign-in that is missing or ended is broken; one that renews itself is fine", () => {
    const now = at.getTime();
    const past = new Date(now - 3600_000);
    expect(serverItems([server({ auth: "oauth" })], now)).toMatchObject([{ kind: "ai.mcp.signin", severity: "broken", since: null }]);
    expect(serverItems([server({ auth: "oauth", has_token: true, token_expires_at: past })], now)).toMatchObject([{ kind: "ai.mcp.signin", since: past.toISOString() }]);
    expect(serverItems([server({ auth: "oauth", has_token: true, token_expires_at: past, token_renews: true })], now)).toEqual([]);
    // Each person signs in for themselves: no company sign-in to miss.
    expect(serverItems([server({ auth: "oauth", oauth_per_user: true })], now)).toEqual([]);
  });
  it("calls failing in a row are a warning; refused for the sign-in, a broken sign-in; a single failure is not news", () => {
    expect(serverItems([server({ failed: 2, failed_since: at })])).toEqual([]);
    expect(serverItems([server({ failed: 4, failed_since: at })])).toMatchObject([{ kind: "ai.mcp.calls", severity: "warning", count: 4 }]);
    expect(serverItems([server({ failed: 3, failed_auth: 3, failed_since: at })])).toMatchObject([{ kind: "ai.mcp.signin", severity: "broken" }]);
  });
  it("one item per server, the worst; a server never checked is unknown", () => {
    expect(serverItems([server({ test_ok: false, test_error: "ENOTFOUND", failed: 5 })])).toMatchObject([{ kind: "ai.mcp.failed", detail: "ENOTFOUND" }]);
    expect(serverItems([server({ test_ok: null, tools_at: null })])).toMatchObject([{ kind: "ai.mcp.unchecked", severity: "unknown" }]);
  });
});

describe("the main model", () => {
  it("is listed only while it fails over, with why", () => {
    expect(modelItems(undefined, "gateway")).toEqual([]);
    expect(modelItems({ degraded: false }, "gateway")).toEqual([]);
    expect(modelItems({ degraded: true, reason: "rate_limited", since: "2026-11-13T07:00:00.000Z" }, "gateway")).toMatchObject([
      { kind: "ai.model.quota", since: "2026-11-13T07:00:00.000Z" },
    ]);
    expect(modelItems({ degraded: true, reason: "failing" }, "gateway")).toMatchObject([{ kind: "ai.model.down", since: null }]);
  });
});
