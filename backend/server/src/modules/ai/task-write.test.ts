import { describe, expect, it } from "vitest";
import { addedFacts, buildWritePrompt, cleanTitle, maskMentions, MAX_INPUT, parseWriteOutput, unmaskMentions, writeLanguage } from "./task-write.js";

describe("task write prompt", () => {
  it("asks for the structured sections in the text's language and wraps the text as untrusted", () => {
    const p = buildWritePrompt({ mode: "draft", title: "Chuẩn bị hội thảo khách hàng", description: "" }, "vi");
    expect(p.system).toContain("## Mục tiêu");
    expect(p.system).toContain("## Tiêu chí hoàn thành");
    expect(p.system).toContain("Write in Vietnamese");
    expect(p.system).toMatch(/Never invent facts/);
    expect(p.user).toContain("<untrusted_content>");
    expect(p.user).toContain("TITLE: Chuẩn bị hội thảo khách hàng");
    expect(p.truncated).toBe(false);
  });

  it("uses English headings for English text", () => {
    const p = buildWritePrompt({ mode: "criteria", title: "Fix the export", description: "" }, "en");
    expect(p.system).toContain('"## Done when"');
    expect(p.system).toContain("Write in English");
  });

  it("adds context, the custom request and cuts long descriptions", () => {
    const p = buildWritePrompt(
      { mode: "custom", title: "X", description: "a".repeat(MAX_INPUT + 50), instruction: "Viết cho <khách>", project: { name: "Website" }, labels: ["web"] },
      "vi",
    );
    expect(p.truncated).toBe(true);
    expect(p.user).toContain('"project":"Website"');
    expect(p.user).toContain("<request>Viết cho ‹khách></request>");
    expect(p.user).toContain("…(cut)");
  });

  it("never sends user ids: mentions become placeholders and come back", () => {
    const m = maskMentions("Ask <@01USER> and <@agent:bot>, then <@01USER> again");
    expect(m.text).toBe("Ask @P1 and @P2, then @P1 again");
    expect(m.ids).toEqual(["01USER", "agent:bot"]);
    expect(unmaskMentions("Hỏi @P1 rồi @P2, @P9 bịa", m.ids)).toBe("Hỏi <@01USER> rồi <@agent:bot>, bịa");
    const p = buildWritePrompt({ mode: "improve", title: "t", description: "cc <@01USER>" }, "en");
    expect(p.user).not.toContain("01USER");
    expect(p.mentions).toEqual(["01USER"]);
  });

  it("picks the text's language, else the interface language", () => {
    expect(writeLanguage("Sửa lỗi đăng nhập", "", "en")).toBe("vi");
    expect(writeLanguage("Write the release notes", "", "vi")).toBe("en");
    expect(writeLanguage("WEB-42", "", "en")).toBe("en");
  });
});

describe("task write output", () => {
  const cur = { title: "fix login", description: "users cant login on safari" };

  it("reads JSON and proposes a title only when improving and changed", () => {
    const text = '```json\n{"title": "Sửa lỗi đăng nhập trên Safari.", "description": "## Mục tiêu\\nNgười dùng Safari đăng nhập được."}\n```';
    expect(parseWriteOutput(text, "improve", cur, [])).toEqual({ title: "Sửa lỗi đăng nhập trên Safari", description: "## Mục tiêu\nNgười dùng Safari đăng nhập được." });
    expect(parseWriteOutput(text, "draft", cur, [])).toEqual({ description: "## Mục tiêu\nNgười dùng Safari đăng nhập được." });
    expect(parseWriteOutput('{"title": "fix login", "description": "x"}', "improve", cur, [])).toEqual({ description: "x" });
  });

  it("takes a plain Markdown answer as the description and restores mentions", () => {
    expect(parseWriteOutput("```markdown\n- [ ] Hỏi @P1\n```", "checklist", cur, ["u1"])).toEqual({ description: "- [ ] Hỏi <@u1>" });
  });

  it("refuses output it cannot use", () => {
    expect(parseWriteOutput("", "draft", cur, [])).toBeNull();
    expect(parseWriteOutput("{broken", "draft", cur, [])).toBeNull();
    expect(parseWriteOutput('{"title": "", "description": ""}', "improve", cur, [])).toBeNull();
  });

  it("cleans titles", () => {
    expect(cleanTitle('"Viết tài liệu API"\n')).toBe("Viết tài liệu API");
    expect(cleanTitle("## Plan the launch.")).toBe("Plan the launch");
  });

  it("lists dates, numbers, links and people the answer added", () => {
    expect(addedFacts("Launch 2 pages by 15/11", "Launch 2 pages by 15/11 and 30/11 for 500 users, see https://x.io <@u2>")).toEqual(["30/11", "500", "https://x.io", "<@u2>"]);
    expect(addedFacts("Bước 1", "- [ ] Bước 1\n- [ ] Bước 2")).toEqual([]);
  });
});
