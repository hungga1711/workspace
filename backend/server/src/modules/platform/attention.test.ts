import { describe, expect, it } from "vitest";
import { webhookItems, type HookRow } from "./attention.js";

const at = new Date("2026-11-12T08:00:00Z");
const hook = (o: Partial<HookRow>): HookRow => ({
  id: "w1",
  url: "https://hooks.example.com/in/s3cret-path",
  description: "",
  active: true,
  failure_count: 0,
  disabled_reason: null,
  created_by: "minh",
  failing_since: null,
  last_status: null,
  last_error: null,
  ...o,
});

describe("webhooks that need an admin", () => {
  it("a webhook that delivers, or failed once, is not listed", () => {
    expect(webhookItems([hook({}), hook({ failure_count: 2 })])).toEqual([]);
  });
  it("one failing in a row is a warning, named by its host only, with the last answer", () => {
    expect(webhookItems([hook({ failure_count: 5, failing_since: at, last_status: 500 })])).toEqual([
      {
        id: "platform.webhook.failing:w1",
        kind: "platform.webhook.failing",
        severity: "warning",
        since: at.toISOString(),
        name: "hooks.example.com",
        detail: "HTTP 500",
        ownerId: "minh",
        count: 5,
      },
    ]);
  });
  it("one the system switched off is broken; one a person switched off is their decision", () => {
    expect(
      webhookItems([hook({ active: false, disabled_reason: "auto_disabled_failures", failure_count: 20, description: "To the CRM", last_error: "ECONNREFUSED" })]),
    ).toMatchObject([{ kind: "platform.webhook.disabled", severity: "broken", name: "To the CRM", detail: "ECONNREFUSED", since: null }]);
    expect(webhookItems([hook({ active: false, failure_count: 7 })])).toEqual([]);
  });
});
