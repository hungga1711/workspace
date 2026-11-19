import { describe, expect, it } from "vitest";
import { answerFrom, detectLang, draftSection, keywords, parseDay, parseTaskRequest, plainLines, planSteps, resolveFollowUp, suggestAssignee, type Turn } from "./local-model.js";

// Wednesday 28 October 2026, 11:30 in London (GMT since the 25th).
const now = new Date("2026-10-28T11:30:00Z");
const tz = "Europe/London";
const day = (s: string) => parseDay(s, now, tz);
const roster = [
  { id: "u-maya", name: "Maya Patel", title: "Head of Engineering", load: 6 },
  { id: "u-liam", name: "Liam Thompson", title: "Frontend Engineer", load: 2 },
  { id: "u-ben", name: "Ben Okafor", title: "Backend Lead", load: 1 },
  { id: "u-aaron", name: "Aaron Yilmaz", title: "Sales Development Rep", load: 0 },
];

describe("parseDay", () => {
  it("reads relative days", () => {
    expect(day("today")).toBe("2026-10-28");
    expect(day("due tomorrow")).toBe("2026-10-29");
    expect(day("in 3 days")).toBe("2026-10-31");
    expect(day("in two weeks")).toBe("2026-11-11");
    expect(day("next week")).toBe("2026-11-02");
    expect(day("end of the week")).toBe("2026-10-30");
    expect(day("by the end of the month")).toBe("2026-10-31");
  });
  it("reads weekdays: the coming one, and next week's for 'next'", () => {
    expect(day("by Friday")).toBe("2026-10-30");
    expect(day("this Friday")).toBe("2026-10-30");
    expect(day("next Friday")).toBe("2026-11-06");
    expect(day("on Monday")).toBe("2026-11-02");
    expect(day("Wednesday")).toBe("2026-11-04");
  });
  it("reads written dates, day before month", () => {
    expect(day("move it to 6/11")).toBe("2026-11-06");
    expect(day("6/11/2027")).toBe("2027-11-06");
    expect(day("2026-12-01")).toBe("2026-12-01");
    expect(day("6 November")).toBe("2026-11-06");
    expect(day("Nov 6th")).toBe("2026-11-06");
    expect(day("12th of December")).toBe("2026-12-12");
    expect(day("3 January")).toBe("2027-01-03");
    expect(day("ship v1.2 soon")).toBeNull();
  });
  it("reads Vietnamese", () => {
    expect(day("dời hạn sang 20/11")).toBe("2026-11-20");
    expect(day("ngày mai")).toBe("2026-10-29");
    expect(day("3 ngày nữa")).toBe("2026-10-31");
    expect(day("thứ sáu tuần sau")).toBe("2026-11-06");
  });
  it("knows when the due date is cleared, and when nothing is named", () => {
    expect(day("remove the due date")).toBe("none");
    expect(day("make it high priority")).toBeNull();
  });
});

describe("parseTaskRequest", () => {
  const parse = (s: string) => parseTaskRequest(s, { now, timeZone: tz, roster });
  it("understands a combined English request", () => {
    expect(parse("set priority to high and due date to next Friday")).toEqual({ priority: "high", dueAt: "2026-11-06T17:00:00.000Z" });
    expect(parse("due tomorrow, urgent, assign to Maya")).toEqual({ dueAt: "2026-10-29T17:00:00.000Z", priority: "urgent", assigneeId: "u-maya" });
  });
  it("reads status words without confusing 'done by' with done", () => {
    expect(parse("mark it as done")).toEqual({ status: "done" });
    expect(parse("start working on it")).toEqual({ status: "in_progress" });
    expect(parse("ready for review")).toEqual({ status: "review" });
    expect(parse("reopen it")).toEqual({ status: "todo" });
    expect(parse("needs to be done by Friday").status).toBeUndefined();
  });
  it("assigns by first or full name and unassigns", () => {
    expect(parse("give it to liam thompson")).toEqual({ assigneeId: "u-liam" });
    expect(parse("reassign to Ben")).toEqual({ assigneeId: "u-ben" });
    expect(parse("assign to Nobody Known")).toEqual({});
    expect(parse("unassign it")).toEqual({ assigneeId: null });
  });
  it("renames, blocks and lowers priority", () => {
    expect(parse("rename it to Ship the pricing page on Friday")).toEqual({ title: "Ship the pricing page on Friday" });
    expect(parse("blocked by the bank's sandbox credentials")).toEqual({ blockedReason: "the bank's sandbox credentials" });
    expect(parse("low priority, no due date")).toEqual({ priority: "low", dueAt: null });
  });
  it("still understands Vietnamese", () => {
    expect(parse("dời hạn sang 20/11, ưu tiên cao, giao cho Maya")).toEqual({ dueAt: "2026-11-20T17:00:00.000Z", priority: "high", assigneeId: "u-maya" });
    expect(parse("đã xong")).toEqual({ status: "done" });
  });
});

describe("suggestAssignee", () => {
  it("prefers a matching job title over the emptiest calendar", () => {
    expect(suggestAssignee("Pricing page with the annual toggle", roster, "en")).toMatchObject({
      assigneeId: "u-liam",
      reason: "Frontend Engineer fits this work, and Liam has 2 open tasks.",
    });
    expect(suggestAssignee("Webhook retries for the payment service", roster, "en").assigneeId).toBe("u-ben");
  });
  it("falls back to the lightest workload, in the reader's language", () => {
    expect(suggestAssignee("Tidy the shared drive", roster, "en")).toEqual({ assigneeId: "u-aaron", reason: "Lightest workload right now (0 open tasks)." });
    expect(suggestAssignee("Dọn thư mục chung", roster, "vi").reason).toMatch(/ít việc mở nhất/);
  });
  it("without workloads, suggests only someone whose title fits", () => {
    const names = roster.map(({ load: _load, ...r }) => ({ ...r, title: `${r.title}, Engineering` }));
    expect(suggestAssignee("Shrink images on the product page", names, "en")).toEqual({ assigneeId: "u-liam", reason: "Frontend Engineer fits this work." });
    expect(suggestAssignee("Tidy the shared drive", names, "en")).toEqual({ assigneeId: null, reason: "" });
  });
});

describe("documents", () => {
  const doc =
    "# Expense policy\n\n| Expense | Limit | Approval |\n|---|---|---|\n| Team lunch | £25 per person | Manager |\n| Travel | Economy | Finance |\n\nSubmit receipts in **Requests** within 30 days.";
  it("reads tables as sentences, never as pipes", () => {
    expect(plainLines(doc)).toEqual([
      "Expense policy",
      "Team lunch: Limit £25 per person; Approval Manager",
      "Travel: Limit Economy; Approval Finance",
      "Submit receipts in Requests within 30 days.",
    ]);
    expect(plainLines("hi <@u1> and <@u2>", { u1: "Lan" })).toEqual(["hi @Lan and"]);
  });
  it("answers from the matching sentence", () => {
    expect(answerFrom(doc, "What is the limit for a team lunch?")[0]).toBe("Team lunch: Limit £25 per person; Approval Manager");
    expect(answerFrom(doc, "parking?")).toEqual([]);
  });
  it("drafts a section from the document", () => {
    expect(draftSection("Write a short paragraph about receipts", "Expense policy", doc, "en")).toBe("## Receipts\n\nSubmit receipts in Requests within 30 days.");
  });
});

describe("language and keywords", () => {
  it("detects the question's language", () => {
    expect(detectLang("Summarise my overdue tasks")).toBe("en");
    expect(detectLang("việc của tôi là gì")).toBe("vi");
    expect(detectLang("T-104")).toBeNull();
  });
  it("keeps the words worth searching", () => {
    expect(keywords("What is the limit for a team lunch?")).toEqual(["limit", "lunch", "team"]);
  });
});

describe("planSteps", () => {
  it("keeps steps the description lists", () => {
    expect(planSteps("Anything", ["Write the copy", "Ship it"], "en")).toEqual(["Write the copy", "Ship it"]);
  });
  it("proposes steps from the title alone", () => {
    expect(planSteps("Pricing page with the annual toggle", [], "en")[1]).toBe("Build the UI");
    expect(planSteps("Webhook retries", [], "en")[2]).toBe("Add tests");
    expect(planSteps("Idempotent webhooks for refunds", [], "en")[2]).toBe("Add tests");
    expect(planSteps("Book the venue", [], "en")[0]).toBe("Agree the scope of “Book the venue” and what done looks like");
  });
});

describe("resolveFollowUp", () => {
  const ans = (content: string): Turn => ({ role: "assistant", content });
  const ask = (content: string): Turn => ({ role: "user", content });
  const lead = [ask("Who is the frontend lead?"), ans("Here is what I found in the workspace:\n- Tom Becker: Frontend Lead, Engineering, reports to Maya Patel")];
  it("puts the last person in for a pronoun", () => {
    expect(resolveFollowUp("What is he working on?", lead)).toBe("What is Tom Becker working on?");
    expect(resolveFollowUp("how many tasks are overdue for her?", lead)).toBe("how many tasks are overdue for Tom Becker?");
    expect(resolveFollowUp("Show me his tasks", lead)).toBe("Show me Tom Becker's tasks");
  });
  it("reads 'and X?' in the shape of the last question", () => {
    expect(resolveFollowUp("and the design lead?", lead)).toBe("Who is the design lead?");
    expect(resolveFollowUp("What about Maya?", [ask("What is Liam working on?"), ans("- Liam Thompson, Frontend Engineer: 1 open task")])).toBe("What is Maya working on?");
  });
  it("takes the person from the latest turn that names one", () => {
    expect(resolveFollowUp("and the design lead?", [...lead, ask("What is he working on?"), ans("- Tom Becker, Frontend Lead: 2 open tasks")])).toBe("Who is the design lead?");
    const more = [...lead, ask("and the design lead?"), ans("Here is what I found in the workspace:\n- Lily Chen: Design Lead, Product & Design, reports to Sofia Alvarez")];
    expect(resolveFollowUp("how many tasks are overdue for her?", more)).toBe("how many tasks are overdue for Lily Chen?");
    expect(resolveFollowUp("How is Tessa doing?", more)).toBe("How is Tessa doing?");
    expect(resolveFollowUp("what about Tom?", [...more, ask("how many tasks are overdue for her?"), ans("- Lily Chen: 0 overdue")])).toBe("how many tasks are overdue for Tom?");
  });
  it("names the last project for 'that project' and 'it'", () => {
    const p = [ask("Which projects are behind?"), ans("Here is what I found in the workspace:\n- P-010: Customer portal 2.0: 33 open, 4 overdue, due 25/12/2026")];
    expect(resolveFollowUp("What is the status of that project?", p)).toBe("What is the status of the Customer portal 2.0 project?");
    expect(resolveFollowUp("when is it due?", p)).toBe("when is the Customer portal 2.0 project due?");
  });
  it("names the last document for 'it'", () => {
    const d = [ask("Summarise the checkout research doc"), ans("Here is a summary of “Checkout redesign: research findings”:\n- Plans are hard to compare.")];
    expect(resolveFollowUp("Who wrote it?", d)).toBe("Who wrote Checkout redesign: research findings?");
  });
  it("understands Vietnamese follow-ups", () => {
    expect(resolveFollowUp("Anh ấy đang làm gì?", lead)).toBe("Tom Becker đang làm gì?");
    expect(resolveFollowUp("còn Lily thì sao?", [ask("Tessa đang làm gì?"), ans("- Tessa Byrne, Senior Frontend Engineer: 5 open tasks")])).toBe("Lily đang làm gì?");
  });
  it("leaves a question that stands alone, or the first one, as it is", () => {
    expect(resolveFollowUp("What is our travel expense policy?", lead)).toBe("What is our travel expense policy?");
    expect(resolveFollowUp("What is he working on?", [])).toBe("What is he working on?");
  });
});
