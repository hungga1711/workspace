import { describe, expect, it } from "vitest";
import { makeT } from "@/lib/i18n/dicts";
import { adminErrorText, webhookDisabledText } from "./api-errors";

const err = (status: number, body: Record<string, string>) => ({ status, body });

describe("adminErrorText", () => {
  it("words known codes in the reader's language, not the module's English message", () => {
    const e = err(400, { error: "cannot_disable_self", message: "you cannot deactivate your own account" });
    expect(adminErrorText(makeT("en"), e, "x")).toBe("You can't deactivate your own account.");
    expect(adminErrorText(makeT("vi"), e, "x")).toBe("Bạn không thể tự vô hiệu hoá tài khoản của mình.");
  });
  it("falls back to a no-permission text, then the message, then the caller's fallback", () => {
    expect(adminErrorText(makeT("en"), err(403, { error: "Forbidden", message: "missing permission member.invite" }), "x")).toMatch(/permission/);
    expect(adminErrorText(makeT("en"), err(400, { message: "bad thing" }), "x")).toBe("bad thing");
    expect(adminErrorText(makeT("en"), err(500, {}), "fallback")).toBe("fallback");
    expect(webhookDisabledText(makeT("vi"), "auto_disabled_failures")).toMatch(/20 lần/);
  });
});
