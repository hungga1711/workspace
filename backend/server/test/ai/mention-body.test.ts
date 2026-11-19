import { describe, expect, it } from "vitest";
import { mentionBody, withoutMention } from "../../src/modules/ai/mention.js";

const id = "01M78ATDG74WWAYAVD0R8C2WMM";

describe("@AI request", () => {
  it("a channel question may say which thread it was asked in", () => {
    const b = mentionBody.parse({ surface: "channel", channelId: id, threadId: id, content: " what was decided? " });
    expect(b).toMatchObject({ surface: "channel", threadId: id, content: "what was decided?", refs: [] });
    expect(mentionBody.parse({ surface: "channel", channelId: id, content: "hi" })).not.toHaveProperty("threadId");
  });

  it("refuses a thread id that is not an id, and an empty question", () => {
    expect(mentionBody.safeParse({ surface: "channel", channelId: id, threadId: "nope", content: "hi" }).success).toBe(false);
    expect(mentionBody.safeParse({ surface: "task", taskId: "T-1", content: "  " }).success).toBe(false);
  });

  it("drops the mention that addressed the assistant", () => {
    expect(withoutMention("@AI, summarise this thread")).toBe("summarise this thread");
    expect(withoutMention("@ai")).toBe("@ai");
  });
});
