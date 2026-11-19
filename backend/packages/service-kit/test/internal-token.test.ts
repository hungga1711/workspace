import { describe, expect, it } from "vitest";
import { signInternalToken, verifyInternalToken } from "../src/internal-token.js";
import type { Principal } from "@workspace/shared";

const principal: Principal = {
  type: "user",
  id: "u1",
  teamIds: [],
  departmentId: null,
  grants: [{ permission: "task.read", scope: "WORKSPACE" }],
};
const SECRET = "test-secret-at-least-32-bytes-long!!";

describe("internal principal token", () => {
  it("round-trips the principal", async () => {
    const t = await signInternalToken({ principal, requestId: "r1" }, SECRET);
    expect(await verifyInternalToken(t, SECRET)).toEqual({ principal, requestId: "r1" });
  });

  it("rejects a token signed with another secret", async () => {
    const t = await signInternalToken({ principal, requestId: "r1" }, "another-secret-another-secret-123");
    await expect(verifyInternalToken(t, SECRET)).rejects.toThrow();
  });

  it("rejects a tampered principal", async () => {
    const t = await signInternalToken({ principal, requestId: "r1" }, SECRET);
    const [h, p, s] = t.split(".");
    const body = JSON.parse(Buffer.from(p!, "base64url").toString());
    body.principal.id = "u2";
    const forged = `${h}.${Buffer.from(JSON.stringify(body)).toString("base64url")}.${s}`;
    await expect(verifyInternalToken(forged, SECRET)).rejects.toThrow();
  });

  it("rejects an expired token", async () => {
    const t = await signInternalToken({ principal, requestId: "r1" }, SECRET, -1);
    await expect(verifyInternalToken(t, SECRET)).rejects.toThrow(/exp/);
  });
});
