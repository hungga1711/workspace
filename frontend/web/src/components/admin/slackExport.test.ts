import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { planSlack, slackText } from "./slackExport";

const zip = (files: Record<string, unknown>) => {
  const z = zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(JSON.stringify(v))])));
  return z.buffer.slice(z.byteOffset, z.byteOffset + z.byteLength) as ArrayBuffer;
};

describe("Slack export", () => {
  it("turns Slack markup into readable text", () => {
    expect(slackText("Hi <@U1>, see <#C2|general> and <https://x.vn|the doc> &amp; <!here>", () => "Lan")).toBe("Hi @Lan, see #general and the doc (https://x.vn) & @here");
  });

  it("reads channels, threads and people, matching people by email or name", () => {
    const plan = planSlack(
      zip({
        "users.json": [
          { id: "U1", name: "lan", profile: { email: "lan@congty.vn", real_name: "Nguyễn Lan" } },
          { id: "U2", name: "tu", profile: { real_name: "Freelancer Tú" } },
        ],
        "channels.json": [{ name: "du-an", purpose: { value: "Dự án Alpha" } }],
        "du-an/2025-06-01.json": [
          { type: "message", user: "U1", text: "Bắt đầu <@U2>", ts: "1748743200.000100" },
          { type: "message", user: "U2", text: "Ok", ts: "1748743300.000200", thread_ts: "1748743200.000100" },
          { type: "message", subtype: "channel_join", user: "U2", text: "<@U2> has joined", ts: "1748743400.000300" },
        ],
      }),
      [{ userId: "u-lan", displayName: "Lan", email: "lan@congty.vn" }],
    );
    expect(plan).toMatchObject({ people: 2, matched: 1 });
    expect(plan.channels[0]).toMatchObject({ name: "du-an", topic: "Dự án Alpha", truncated: false });
    expect(plan.channels[0]!.messages).toEqual([
      { key: "1748743200.000100", threadKey: null, at: "2025-06-01T02:00:00.000Z", text: "Bắt đầu @Freelancer Tú", userId: "u-lan", authorName: "Nguyễn Lan" },
      { key: "1748743300.000200", threadKey: "1748743200.000100", at: "2025-06-01T02:01:40.000Z", text: "Ok", userId: null, authorName: "Freelancer Tú" },
    ]);
  });
});
