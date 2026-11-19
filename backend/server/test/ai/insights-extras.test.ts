import { describe, expect, it } from "vitest";
import { classifyCompany, parseTopicReply, topicKey, topicList, topicRules, type CompanyTopic } from "../../src/modules/ai/topics.js";
import { prefixQuery, redactForLibrary } from "../../src/modules/ai/library.js";
import { capabilityMap, helpfulScore } from "../../src/modules/ai/capability.js";
import { importKey, parseWhen, sourceFromTool } from "../../src/modules/ai/imports.js";
import { firstDue, mailLang, mondayOf, recommend, recommendationText, reportEmail, weeklyDue, type ReportInput } from "../../src/modules/ai/report.js";

const topic = (key: string, keywords: string[], over: Partial<CompanyTopic> = {}): CompanyTopic => ({
  key,
  labelVi: key,
  labelEn: key,
  keywords,
  builtin: !key.startsWith("c_"),
  archived: false,
  ...over,
});

describe("company topics", () => {
  it("makes ASCII keys from Vietnamese labels", () => {
    expect(topicKey("Báo giá khách hàng")).toBe("c_bao_gia_khach_hang");
    expect(topicKey("Đấu thầu")).toBe("c_dau_thau");
    expect(topicKey("!!!")).toBe("c_topic");
  });

  it("tries the company's own topics first, then extra keywords on built-in ones, then the built-in rules", () => {
    const rules = topicRules([topic("c_tender", ["hồ sơ thầu", "tender"]), topic("sales", ["PO"]), topic("c_old", ["email"], { archived: true })]);
    // "email" alone would be writing; the company's tender topic wins when its words appear.
    expect(classifyCompany("Viết email nộp hồ sơ thầu", rules)).toBe("c_tender");
    expect(classifyCompany("Kiểm tra PO số 12", rules)).toBe("sales");
    // Archived topics are not assigned any more.
    expect(classifyCompany("Soạn email cảm ơn", rules)).toBe("writing");
    // Whole words only: "potato" does not contain the keyword PO.
    expect(classifyCompany("potato salad", rules)).toBe("other");
  });

  it("lists built-ins (with the company's labels) before the company's topics", () => {
    const list = topicList([topic("code", [], { labelVi: "Phần mềm" }), topic("c_x", ["x1"])]);
    expect(list[0]).toMatchObject({ key: "code", labelVi: "Phần mềm", builtin: true });
    expect(list.at(-1)).toMatchObject({ key: "c_x", builtin: false });
    expect(list.filter((t) => t.builtin)).toHaveLength(10);
  });

  it("keeps only keys from the company's list in the model's answer", () => {
    expect(parseTopicReply('{"1": "code", "2": "c_tender", "3": "hacked"}', 3, ["code", "c_tender", "other"])).toEqual([
      [0, "code"],
      [1, "c_tender"],
    ]);
    expect(parseTopicReply("not json", 2, ["code"])).toEqual([]);
  });
});

describe("prompt library", () => {
  it("masks built-in kinds and the company's keywords", () => {
    const out = redactForLibrary("Gửi báo giá cho Acme Corp, liên hệ an@acme.vn, mã dự án PX-12", ["Acme Corp", "PX-12"]);
    expect(out).not.toContain("Acme Corp");
    expect(out).not.toContain("an@acme.vn");
    expect(out).not.toContain("PX-12");
    expect(out.match(/\[KEYWORD\]/g)).toHaveLength(2);
  });

  it("searches words as prefixes", () => {
    expect(prefixQuery("báo giá")).toBe("báo:* & giá:*");
    expect(prefixQuery("a !")).toBeNull();
    expect(prefixQuery("x'; DROP")).toBe("drop:*");
  });
});

describe("capability map", () => {
  const people = [
    { userId: "a", displayName: "An", department: "Sales" },
    { userId: "b", displayName: "Bình", department: "Sales" },
    { userId: "c", displayName: "Chi", department: "Sales" },
    { userId: "d", displayName: "Dũng", department: null },
  ];
  it("suggests heavy users people rate helpful as mentors, at most two per department", () => {
    const map = capabilityMap(people, [
      { userId: "a", conversations: 8, prompts: 40, rated: 6, yes: 5, partly: 1 },
      { userId: "b", conversations: 3, prompts: 12, rated: 4, yes: 1, partly: 0 },
      { userId: "c", conversations: 2, prompts: 4, rated: 2, yes: 2, partly: 0 },
      { userId: "d", conversations: 9, prompts: 30, rated: 5, yes: 5, partly: 0 },
    ]);
    const sales = map.find((d) => d.name === "Sales")!;
    expect(sales.active).toBe(3);
    expect(sales.top[0]).toMatchObject({ userId: "a", mentor: true });
    // Rated unhelpful (b) or too few uses (c): not mentors.
    expect(sales.top.filter((t) => t.mentor).map((t) => t.userId)).toEqual(["a"]);
    // People without a department come last.
    expect(map.at(-1)!.name).toBeNull();
    expect(helpfulScore({ rated: 4, yes: 2, partly: 2 })).toBe(0.75);
    expect(helpfulScore({ rated: 0, yes: 0, partly: 0 })).toBeNull();
  });
});

describe("provider import", () => {
  it("maps tool and model names to sources", () => {
    expect(sourceFromTool("ChatGPT Enterprise")).toBe("chatgpt");
    expect(sourceFromTool(undefined, "gpt-4o")).toBe("chatgpt");
    expect(sourceFromTool("Claude for Work")).toBe("claude");
    expect(sourceFromTool("", "gemini-2.5-pro")).toBe("gemini");
    expect(sourceFromTool("Microsoft 365 Copilot")).toBe("copilot");
    expect(sourceFromTool("Internal bot")).toBe("import");
  });

  it("reads ISO, spreadsheet and Unix timestamps", () => {
    expect(parseWhen("2026-10-20T08:15:00Z")?.toISOString()).toBe("2026-10-20T08:15:00.000Z");
    expect(parseWhen("2026-10-20 08:15:00Z")?.toISOString()).toBe("2026-10-20T08:15:00.000Z");
    expect(parseWhen("1760947200")?.toISOString()).toBe("2025-10-20T08:00:00.000Z");
    expect(parseWhen("1760947200000")?.toISOString()).toBe("2025-10-20T08:00:00.000Z");
    expect(parseWhen("yesterday")).toBeNull();
  });

  it("gives the same row the same key", () => {
    const at = new Date("2026-10-20T08:00:00Z");
    const a = importKey("u1", { at: "x", tool: "t", title: "Hello" }, at);
    expect(importKey("u1", { at: "y", tool: "t", title: "Hello" }, at)).toBe(a);
    expect(importKey("u2", { at: "x", tool: "t", title: "Hello" }, at)).not.toBe(a);
    expect(a).toMatch(/^imp:[0-9a-f]{40}$/);
  });
});

describe("weekly report", () => {
  const base: ReportInput = {
    people: 10,
    extension: 8,
    conversations: 40,
    rated: 20,
    helpful: { yes: 12, partly: 4, no: 4 },
    flagged: 0,
    safety: { warn: 0, redact: 0, block: 0 },
    sensitiveMode: "warn",
    topics: [{ key: "code", prompts: 50, rated: 10, yes: 8, partly: 0 }],
    departments: [{ name: "Sales", people: 4, active: 3 }],
    mentors: [],
    work: { assisted: { done: 5, dated: 4, onTime: 3, cycleDays: 2 }, other: { done: 10, dated: 8, onTime: 5, cycleDays: 3 } },
    unpricedTokens: 0,
    library: 10,
  };

  it("gives three healthy-habit steps in a quiet week", () => {
    expect(recommend(base).map((r) => r.key)).toEqual(["celebrate", "review_policy", "browse_library"]);
    expect(recommend({ ...base, helpful: { yes: 0, partly: 0, no: 0 } })).toHaveLength(3);
  });

  it("puts data safety and adoption before polish", () => {
    const r = recommend({
      ...base,
      extension: 2,
      flagged: 3,
      rated: 2,
      topics: [{ key: "sales", prompts: 9, rated: 4, yes: 0, partly: 1 }],
      departments: [{ name: "Kho", people: 5, active: 0 }],
      unpricedTokens: 100,
    });
    expect(r.map((x) => x.key)).toEqual(["install_extension", "turn_on_redaction", "ask_feedback"]);
    expect(r[0]!.params).toEqual({ missing: 8 });
  });

  it("names a weak topic, mentors and idle departments", () => {
    const r = recommend({
      ...base,
      topics: [{ key: "sales", prompts: 9, rated: 4, yes: 0, partly: 1 }],
      mentors: [{ displayName: "An", department: "Sales" }],
      departments: [{ name: "Kho", people: 5, active: 0 }],
    });
    expect(r.map((x) => x.key)).toEqual(["coach_topic", "pair_mentors", "pilot_department"]);
    expect(recommendationText(r[0]!, "en", (k) => k)).toContain('"sales"');
    expect(recommendationText(r[2]!, "vi", (k) => k)).toContain("Kho");
  });

  it("is due on Monday from 08:00 in the workspace's zone, once a week", () => {
    expect(mondayOf("2026-10-25")).toBe("2026-10-19");
    expect(mondayOf("2026-10-26")).toBe("2026-10-26");
    // 01:30 UTC Monday = 08:30 in Ho Chi Minh City, still Sunday in New York.
    const at = new Date("2026-10-26T01:30:00Z");
    expect(weeklyDue(at, "Asia/Ho_Chi_Minh", null)).toEqual({ due: true, week: "2026-10-26" });
    expect(weeklyDue(at, "Asia/Ho_Chi_Minh", "2026-10-26").due).toBe(false);
    expect(weeklyDue(at, "America/New_York", null).due).toBe(false);
    expect(weeklyDue(new Date("2026-10-26T00:30:00Z"), "Asia/Ho_Chi_Minh", null).due).toBe(false);
  });

  it("writes the email in the workspace's language with a link to the page", () => {
    const report = {
      days: 7,
      timeZone: "Asia/Ho_Chi_Minh",
      generatedAt: "",
      totals: {
        people: 10,
        active: 6,
        extension: 8,
        conversations: 40,
        prompts: 120,
        rated: 20,
        helpful: { yes: 12, partly: 4, no: 4 },
        flagged: 2,
        safety: { warn: 1, redact: 0, block: 0 },
        costUsd: 3.5,
        importedCostUsd: 0,
        unpricedTokens: 0,
      },
      sensitiveMode: "warn" as const,
      topics: [{ key: "c_tender", prompts: 30, rated: 0, yes: 0, partly: 0 }],
      sources: [],
      departments: [],
      people: [],
      mentors: [],
      work: null,
      topicLabels: [{ key: "c_tender", labelVi: "Đấu thầu", labelEn: "Tenders" }],
      recommendations: [{ key: "turn_on_redaction" as const, params: { count: 3 } }],
    };
    const en = reportEmail(report, "en", "https://wx.example");
    expect(en.subject).toContain("40");
    expect(en.text).toContain("Tenders");
    expect(en.text).toContain("https://wx.example/app/ai/adoption/report");
    expect(reportEmail(report, "vi", "https://wx.example").text).toContain("Đấu thầu");
    const first = reportEmail(report, "en", "https://wx.example", true);
    expect(first.subject).toBe("Your company's first AI report");
    expect(first.text).toContain("7 days after setup");
    expect(reportEmail(report, "es", "https://wx.example").text).toContain("Tres cosas");
    expect(reportEmail(report, "zh", "https://wx.example").text).toContain("打开报告");
    // 40 conversations is enough to show numbers; a quiet week says there is too little to compare.
    expect(first.text).not.toContain("Not enough data yet");
    const quiet = reportEmail({ ...report, totals: { ...report.totals, conversations: 3 } }, "en", "https://wx.example");
    expect(quiet.text).toContain("Not enough data yet");
    const none = reportEmail({ ...report, totals: { ...report.totals, conversations: 0, prompts: 0, active: 0 } }, "en", "https://wx.example");
    expect(none.text).toContain("No AI use recorded yet");
  });

  it("sends the first report 7 days after setup, from 08:00 in the workspace's zone, once", () => {
    const since = new Date("2026-11-01T03:00:00Z");
    expect(firstDue(new Date("2026-11-07T03:00:00Z"), "Asia/Ho_Chi_Minh", since, null)).toBe(false); // day 6
    expect(firstDue(new Date("2026-11-08T00:30:00Z"), "Asia/Ho_Chi_Minh", since, null)).toBe(false); // 07:30 local, under 7×24h
    expect(firstDue(new Date("2026-11-08T03:30:00Z"), "Asia/Ho_Chi_Minh", since, null)).toBe(true); // 10:30 local
    expect(firstDue(new Date("2026-11-09T22:00:00Z"), "Europe/London", since, null)).toBe(true); // 22:00
    expect(firstDue(new Date("2026-11-10T06:00:00Z"), "Europe/London", since, null)).toBe(false); // 06:00
    expect(firstDue(new Date("2026-11-12T10:00:00Z"), "Europe/London", since, new Date())).toBe(false);
  });

  it("emails in the person's language, else the workspace's, else English", () => {
    expect(mailLang("es", "vi")).toBe("es");
    expect(mailLang(undefined, "zh")).toBe("zh");
    expect(mailLang("fr", null)).toBe("en");
  });
});
