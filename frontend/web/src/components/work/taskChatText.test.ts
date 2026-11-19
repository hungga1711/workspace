import { describe, expect, it } from "vitest";
import { dayOf, linkCitations, plainAnswer, shortTitle, splitDue, stepsOf, type ChatSource } from "./taskChatText";

const sources: ChatSource[] = [
  { n: 1, type: "task", id: "t1", title: "WEB-42 Fix login", url: "/app/work/tasks/t1" },
  { n: 3, type: "document", id: "d1", title: "Auth runbook", url: "/app/work/docs/d1" },
];

describe("task chat text", () => {
  it("turns known citations into links and leaves made-up ones as written", () => {
    expect(linkCitations("Ask Huy [3]. See [1, 3] and [7].", sources)).toBe("Ask Huy [³](/app/work/docs/d1). See [¹](/app/work/tasks/t1)[³](/app/work/docs/d1) and [7].");
  });

  it("reads a source written as a link to its number", () => {
    expect(linkCitations("See [Auth runbook](#3).", sources)).toBe("See Auth runbook [³](/app/work/docs/d1).");
    expect(plainAnswer("See [Auth runbook](#3).")).toBe("See Auth runbook.");
  });

  it("drops citation numbers for a comment or the description", () => {
    expect(plainAnswer("Set Secure on the cookie [3].\n\n\n\nThen test [1, 3].")).toBe("Set Secure on the cookie.\n\nThen test.");
  });

  it("reads the steps of an answer, two or more", () => {
    expect(stepsOf("Do this:\n1. **Reproduce** on Safari [1]\n2. Check the `SameSite` flag:\n- [ ] Ship it")).toEqual([
      "Reproduce on Safari",
      "Check the SameSite flag",
      "Ship it",
    ]);
    expect(stepsOf("Just one thing:\n1. Fix it")).toEqual([]);
    expect(stepsOf("No list here.")).toEqual([]);
  });
});

describe("splitDue", () => {
  // Thursday 05/11/2026 21:00 in Hanoi.
  const now = new Date("2026-11-05T14:00:00Z");
  const tz = "Asia/Ho_Chi_Minh";
  it("moves a bracketed deadline to the due date (17:00 workspace time)", () => {
    expect(splitDue("Soạn dàn ý bài viết [Hạn: Thứ 2 tuần tới].", now, tz)).toEqual({ title: "Soạn dàn ý bài viết", dueAt: "2026-11-09T10:00:00.000Z" });
    expect(splitDue("Gửi báo giá (hạn 20/11/2026)", now, tz)).toEqual({ title: "Gửi báo giá", dueAt: "2026-11-20T10:00:00.000Z" });
    expect(splitDue("Review draft — due Friday", now, "UTC")).toEqual({ title: "Review draft", dueAt: "2026-11-06T17:00:00.000Z" });
  });
  it("takes a bare trailing deadline out of the title only when it reads as a day", () => {
    expect(splitDue("Prepare onboarding checklist for Clara by Friday", now, "UTC")).toEqual({
      title: "Prepare onboarding checklist for Clara",
      dueAt: "2026-11-06T17:00:00.000Z",
    });
    expect(splitDue("Plan the launch by product team", now, "UTC")).toEqual({ title: "Plan the launch by product team", dueAt: null });
  });
  it("keeps the title when there is no readable deadline", () => {
    expect(splitDue("Gọi khách hàng", now, tz)).toEqual({ title: "Gọi khách hàng", dueAt: null });
    expect(splitDue("Chốt nội dung (hạn: khi có số liệu)", now, tz)).toEqual({ title: "Chốt nội dung (hạn: khi có số liệu)", dueAt: null });
  });
  it("reads relative days", () => {
    expect(dayOf("ngày mai", now, tz)).toEqual([2026, 11, 6]);
    expect(dayOf("thứ 6 tuần này", now, tz)).toEqual([2026, 11, 6]);
    expect(dayOf("thứ 2", now, tz)).toEqual([2026, 11, 9]);
    expect(dayOf("tuần tới", now, tz)).toEqual([2026, 11, 13]);
    expect(dayOf("05/01", new Date("2026-12-20T00:00:00Z"), tz)).toEqual([2027, 1, 5]);
  });
  it("keeps subtask titles short and drops invented task codes", () => {
    expect(shortTitle("T-717: Draft the launch email (due 13/11/2026)")).toBe("Draft the launch email (due 13/11/2026)");
    expect(shortTitle("Review copy with Marketing (T-718).")).toBe("Review copy with Marketing");
    const long = "Collect the usage numbers from the dashboard for every customer segment, then compare them with last quarter and flag anything unusual";
    expect(shortTitle(long).length).toBeLessThanOrEqual(81);
    expect(shortTitle("Prepare the slides for the review: one per feature, with screenshots, speaker notes and a short demo script")).toBe("Prepare the slides for the review");
    expect(stepsOf("1. T-801 Write brief\n2. T-802 Review brief")).toEqual(["Write brief", "Review brief"]);
  });
  it("reads deadlines written in Chinese and Spanish", () => {
    expect(splitDue("起草邮件（截止 20/11/2026）", now, "UTC")).toEqual({ title: "起草邮件", dueAt: "2026-11-20T17:00:00.000Z" });
    expect(splitDue("Revisar el borrador (vence 20/11/2026)", now, "UTC")).toEqual({ title: "Revisar el borrador", dueAt: "2026-11-20T17:00:00.000Z" });
    expect(dayOf("la próxima semana", now, "UTC")).toEqual([2026, 11, 13]);
    expect(dayOf("下周", now, "UTC")).toEqual([2026, 11, 13]);
  });
  it("moves a date inside this week to next week's Friday when the question asked for next week", () => {
    // Thursday 05/11: a model writes Sunday 08/11 for "next week"; next week runs 09–15/11.
    expect(splitDue("Send the quote (due 08/11/2026)", now, "UTC", "Split this into steps due next week")).toEqual({
      title: "Send the quote",
      dueAt: "2026-11-13T17:00:00.000Z",
    });
    expect(splitDue("Send the quote (due 10/11/2026)", now, "UTC", "due next week").dueAt).toBe("2026-11-10T17:00:00.000Z");
  });
});
