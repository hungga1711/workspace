import { describe, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { assignRows, exportKind, exportRows, readExport } from "./ai-export";

const chatgpt = [
  {
    title: "Quote for Fennel Grocers T-062",
    create_time: 1793000000,
    default_model_slug: "gpt-4o",
    mapping: {
      a: { message: { author: { role: "system" }, create_time: 1793000000, content: { parts: ["sys"] } } },
      b: { message: { author: { role: "user" }, create_time: 1793000100, content: { parts: ["Draft a quote for T-062"] }, metadata: { model_slug: "gpt-4o" } } },
      c: { message: { author: { role: "assistant" }, create_time: 1793000110, content: { parts: ["Sure"] } } },
      d: { message: { author: { role: "user" }, create_time: 1793000200, content: { parts: ["shorter"] } } },
      e: { message: { author: { role: "user" }, create_time: 1793000000 + 86400, content: { parts: ["next day"] } } },
      f: null,
    },
  },
];

const claude = [
  {
    uuid: "c1",
    name: "Weekly report",
    created_at: "2026-11-02T09:00:00Z",
    account: { uuid: "u1" },
    chat_messages: [
      { sender: "human", text: "Summarise the week", created_at: "2026-11-02T09:00:00Z" },
      { sender: "assistant", text: "Here", created_at: "2026-11-02T09:00:05Z" },
      { sender: "human", text: "", content: [{ type: "text", text: "More detail" }], created_at: "2026-11-02T09:01:00Z" },
    ],
  },
  { uuid: "c2", name: "Other", created_at: "2026-11-03T09:00:00Z", account: { uuid: "u2" }, chat_messages: [{ sender: "human", text: "hi", created_at: "2026-11-03T09:00:00Z" }] },
];
const claudeUsers = [
  { uuid: "u1", full_name: "Lily Chen", email_address: "lily@brightline.test" },
  { uuid: "u2", full_name: "Tom Becker", email_address: "tom@brightline.test" },
];

describe("chat-history exports", () => {
  it("tells ChatGPT and Claude exports apart", () => {
    expect(exportKind(chatgpt)).toBe("chatgpt");
    expect(exportKind(claude)).toBe("claude");
    expect(exportKind([{ foo: 1 }])).toBeNull();
    expect(exportKind({})).toBeNull();
  });

  it("ChatGPT: one row per day with the person's message count; the single user's email from users.json", () => {
    const r = exportRows("chatgpt", chatgpt, { email: "daniel@brightline.test" });
    expect(r.conversations).toBe(1);
    expect(r.unassigned).toBe(0);
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toMatchObject({
      email: "daniel@brightline.test",
      tool: "chatgpt",
      model: "gpt-4o",
      count: 2,
      title: "Quote for Fennel Grocers T-062",
      prompt: "Draft a quote for T-062",
    });
    expect(r.rows[1]).toMatchObject({ count: 1, prompt: "next day" });
  });

  it("Claude: emails from users.json by account; content parts when text is empty", () => {
    const r = exportRows("claude", claude, claudeUsers);
    expect(r.rows).toEqual([
      expect.objectContaining({ email: "lily@brightline.test", tool: "claude", count: 2, title: "Weekly report", prompt: "Summarise the week" }),
      expect.objectContaining({ email: "tom@brightline.test", count: 1 }),
    ]);
  });

  it("rows without an email go to the person the admin picks, or are dropped", () => {
    const r = exportRows("chatgpt", chatgpt);
    expect(r.unassigned).toBe(2);
    expect(assignRows(r.rows, "ann@x.test").every((x) => x.email === "ann@x.test")).toBe(true);
    expect(assignRows(r.rows, " ")).toHaveLength(0);
  });

  it("reads a zip with conversations.json and users.json, and a bare JSON file", async () => {
    const zip = zipSync({
      "export/conversations.json": strToU8(JSON.stringify(claude)),
      "export/users.json": strToU8(JSON.stringify(claudeUsers)),
      "export/projects.json": strToU8("[]"),
    });
    const z = await readExport("claude-export.zip", zip);
    expect(z?.kind).toBe("claude");
    expect(z?.rows).toHaveLength(2);
    const bare = await readExport("conversations.json", strToU8(JSON.stringify(chatgpt)));
    expect(bare?.kind).toBe("chatgpt");
    expect(await readExport("usage.json", strToU8('{"rows":[]}'))).toBeNull();
  });
});
