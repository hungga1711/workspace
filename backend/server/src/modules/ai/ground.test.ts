import { describe, expect, it } from "vitest";
import { aboutWorkspace, blockedIntent, datesLine, deptMatches, groundedIn, lateIntent, renderBlocked, renderLate } from "./ground.js";
import { closeTruncated, dataAsAnswer, guardAnswer, parseJson, routeIntent } from "./runtime.js";
import { readingFromText, withIds } from "./progress-brief.js";

describe("lateIntent", () => {
  it("reads a person's late question", () => {
    expect(lateIntent("Tessa Byrne đang trễ những việc nào?")).toEqual({ person: "Tessa Byrne" });
    expect(lateIntent("What is Liam Moore late on?")).toEqual({ person: "Liam Moore" });
    expect(lateIntent("việc trễ hạn của Lan?")).toEqual({ person: "Lan" });
  });
  it("reads a group question, with its department", () => {
    expect(lateIntent("Ai đang trễ việc ở Engineering?")).toEqual({ department: "Engineering" });
    expect(lateIntent("who is late in Sales?")).toEqual({ department: "Sales" });
    expect(lateIntent("ai đang trễ việc?")).toEqual({});
  });
  it("leaves other questions alone", () => {
    expect(lateIntent("Viết email chào khách mới")).toBeNull();
    expect(lateIntent("dự án nào đang trễ?")).toBeNull();
    expect(lateIntent("Tessa đang làm gì?")).toBeNull();
  });
});

const team = {
  scope: "everyone" as const,
  people: [
    {
      userId: "u1",
      displayName: "Tessa Byrne",
      department: "Engineering",
      overdue: 2,
      open: 5,
      tasks: [
        { id: "t1", code: "T-236", title: "Fix SSO", status: "in_progress", dueAt: "2026-10-28T10:00:00Z", overdue: true },
        { id: "t2", code: "T-130", title: "Audit logs", status: "todo", dueAt: "2026-10-20T10:00:00Z", overdue: true },
        { id: "t3", code: "T-300", title: "Later", status: "todo", dueAt: "2026-12-20T10:00:00Z", overdue: false },
      ],
    },
    {
      userId: "u2",
      displayName: "Lily Chen",
      department: "Marketing",
      overdue: 1,
      open: 2,
      tasks: [{ id: "t4", code: "T-669", title: "Newsletter", status: "todo", dueAt: "2026-11-01T10:00:00Z", overdue: true }],
    },
    { userId: "u3", displayName: "Ben Okafor", department: "Engineering", overdue: 0, open: 1, tasks: [] },
  ],
};
const now = Date.parse("2026-11-08T10:00:00Z");

describe("renderLate", () => {
  it("lists a person's late tasks with links, oldest first", () => {
    const r = renderLate(team, { person: "tessa" }, "vi", now, "UTC");
    expect(r.text).toContain("[Tessa Byrne](/app/work/people/u1) đang trễ 2 việc");
    expect(r.text.indexOf("T-130")).toBeLessThan(r.text.indexOf("T-236"));
    expect(r.text).toContain("[T-236](/app/work/tasks/t1)");
    expect(r.text).not.toContain("T-300");
  });
  it("narrows to a department and names only real people", () => {
    const r = renderLate(team, { department: "engineering" }, "vi", now, "UTC");
    expect(r.text).toContain("1 người ở engineering");
    expect(r.text).toContain("Tessa Byrne");
    expect(r.text).not.toContain("Lily");
  });
  it("says so when the person or department is unknown", () => {
    expect(renderLate(team, { person: "John" }, "vi", now).text).toContain('Mình không thấy ai tên "John"');
    expect(renderLate(team, { department: "Legal" }, "en", now).text).toContain('don\'t see a department called "Legal"');
  });
});

describe("grounding guard", () => {
  const data = "[người Tessa Byrne] 5 việc đang mở\n[Tessa Byrne · trễ hạn] T-236 Fix SSO (hạn 28/10)";
  it("passes an answer that uses the data", () => {
    expect(groundedIn("Tessa Byrne đang trễ **T-236** Fix SSO.", data, "q").ok).toBe(true);
  });
  it("catches invented task codes and names", () => {
    const fake = "| Task ID | Người phụ trách |\n|---|---|\n| T-001 | Linh Nguyễn |\n| T-002 | John |";
    const r = groundedIn(fake, data, "ai đang trễ?");
    expect(r.ok).toBe(false);
    expect(r.unknown).toEqual(expect.arrayContaining(["T-001", "T-002", "Linh Nguyễn", "John"]));
    expect(guardAnswer(fake, data, "q", "vi")).toBe(dataAsAnswer(data, "vi"));
  });
  it("shows the data as a readable list", () => {
    expect(dataAsAnswer(data, "vi")).toContain("- **Tessa Byrne**: 5 việc đang mở");
  });
});

describe("routeIntent", () => {
  const all = ["team_status", "project_status", "list_my_tasks"];
  it("routes a department and a named project", () => {
    expect(routeIntent("Phòng Engineering tuần này thế nào?", all)).toEqual({ tool: "team_status", input: { department: "Engineering" } });
    expect(routeIntent("Dự án Customer portal 2.0 thế nào?", all)).toEqual({ tool: "project_status", input: { project: "Customer portal 2.0" } });
  });
});

describe("routeIntent: the area tools", () => {
  const extra = [
    "list_my_tasks",
    "team_status",
    "recent_channel_messages",
    "summarize_channel",
    "needs_my_attention",
    "unanswered_questions",
    "workload_balance",
    "overdue_tasks",
    "ai_spend",
    "team_ai_usage",
    "weekly_report_text",
    "org_chart",
    "attendance_summary",
    "workflow_run_status",
  ];
  it("routes what a question clearly asks for", () => {
    expect(routeIntent("Tôi bỏ lỡ gì?", extra)).toEqual({ tool: "summarize_channel", input: {} });
    expect(routeIntent("tóm tắt kênh này", extra, { channelId: "C1" })).toEqual({ tool: "summarize_channel", input: { channel: "C1" } });
    expect(routeIntent("Có gì đang chờ tôi xử lý?", extra)?.tool).toBe("needs_my_attention");
    expect(routeIntent("What needs my attention today?", extra)?.tool).toBe("needs_my_attention");
    expect(routeIntent("Câu hỏi nào chưa ai trả lời?", extra)?.tool).toBe("unanswered_questions");
    expect(routeIntent("Ai đang quá tải?", extra)?.tool).toBe("workload_balance");
    expect(routeIntent("Những việc trễ hạn của phòng Sales", extra)?.tool).not.toBe("list_my_tasks");
    expect(routeIntent("overdue tasks across the company", extra)?.tool).toBe("overdue_tasks");
    expect(routeIntent("Chi phí AI tháng này bao nhiêu?", extra)?.tool).toBe("ai_spend");
    expect(routeIntent("Làm báo cáo tuần", extra)?.tool).toBe("weekly_report_text");
    expect(routeIntent("Show the org chart", extra)?.tool).toBe("org_chart");
    expect(routeIntent("Tuần này ai đi muộn?", extra)?.tool).toBe("attendance_summary");
    expect(routeIntent("Workflow nào bị lỗi?", extra)).toEqual({ tool: "workflow_run_status", input: { failedOnly: true } });
  });
  it("keeps the earlier routes when the area tools are not offered", () => {
    expect(routeIntent("tóm tắt kênh này", ["recent_channel_messages"], { channelId: "C1" })).toEqual({ tool: "recent_channel_messages", input: { channelId: "C1" } });
    expect(routeIntent("Ai đang quá tải?", ["list_my_tasks"])).toBeNull();
  });
});

describe("parseJson", () => {
  it("skips a reasoning block with braces of its own", () => {
    expect(parseJson<{ a: number }>('<think>maybe {"x": 1} or {</think>\n{"a": 2}')).toEqual({ a: 2 });
  });
  it("reads a fenced object after prose", () => {
    expect(parseJson<{ a: number }>('Here it is:\n```json\n{"a": 1}\n```\nHope it helps {not json}')).toEqual({ a: 1 });
  });
  it("closes a reply cut off by the token limit", () => {
    expect(parseJson<{ summary: string; next: string[] }>('{"summary": "Team is behind", "next": ["Call Tessa", "Re-plan')).toEqual({
      summary: "Team is behind",
      next: ["Call Tessa", "Re-plan"],
    });
    expect(closeTruncated('{"a": 1, "b":')).toBe('{"a": 1}');
  });
});

describe("progress reading fallbacks", () => {
  it("turns prose into a summary and next steps", () => {
    expect(readingFromText("The team is behind on billing.\n\n1. Call Tessa\n2. **Move** the release")).toEqual({
      summary: "The team is behind on billing.",
      people: [],
      next: ["Call Tessa", "Move the release"],
    });
  });
  it("maps a name back to its userId", () => {
    const r = withIds({ people: [{ userId: "Tessa Byrne", why: "late", nudge: "hi" }] }, [{ userId: "u1", displayName: "Tessa Byrne" }]);
    expect(r.people?.[0]?.userId).toBe("u1");
  });
});

describe("datesLine", () => {
  it("spells out this week and next week in the workspace zone", () => {
    const line = datesLine(new Date("2026-11-08T20:00:00Z"), "Asia/Ho_Chi_Minh"); // Monday 09/11 in Hanoi
    expect(line).toContain("Today is Monday 09/11/2026");
    expect(line).toContain("runs Monday 16/11/2026 to Sunday 22/11/2026");
    expect(line).toContain('"next week" with no day means Friday 20/11/2026');
    expect(line).toContain("(due dd/mm/yyyy)");
    expect(datesLine(new Date("2026-11-08T20:00:00Z"), "Asia/Ho_Chi_Minh", "vi")).toContain("(hạn dd/mm/yyyy)");
    expect(datesLine(new Date("2026-11-08T20:00:00Z"), "Asia/Ho_Chi_Minh", "es")).toContain("(vence dd/mm/yyyy)");
  });
  it("on a Sunday, next week starts tomorrow", () => {
    expect(datesLine(new Date("2026-11-15T03:00:00Z"), "UTC")).toContain("runs Monday 16/11/2026 to Sunday 22/11/2026");
  });
});

describe("the boss's questions in four languages", () => {
  const all = ["team_status", "project_status", "who_is_out", "my_leave_balance", "list_my_tasks", "goals_status", "delegated_status", "team_ai_usage"];
  const route = (q: string) => routeIntent(q, all);
  it("finds late questions in en, vi, zh and es", () => {
    // English
    expect(lateIntent("Who is late?")).toEqual({});
    expect(lateIntent("who is late in Sales?")).toEqual({ department: "Sales" });
    expect(lateIntent("What is Liam Moore late on?")).toEqual({ person: "Liam Moore" });
    expect(lateIntent("Which tasks are overdue for my team?")).toEqual({});
    expect(lateIntent("Who has overdue tasks in Engineering?")).toEqual({ department: "Engineering" });
    // Tiếng Việt
    expect(lateIntent("Ai đang trễ việc?")).toEqual({});
    expect(lateIntent("Ai đang trễ việc ở Engineering?")).toEqual({ department: "Engineering" });
    expect(lateIntent("Tessa Byrne đang trễ những việc nào?")).toEqual({ person: "Tessa Byrne" });
    expect(lateIntent("việc trễ hạn của Lan?")).toEqual({ person: "Lan" });
    expect(lateIntent("Nhân viên nào đang chậm việc?")).toEqual({});
    // 中文
    expect(lateIntent("谁的任务逾期了？")).toEqual({});
    expect(lateIntent("工程部谁的任务逾期了？")).toEqual({ department: "工程" });
    expect(lateIntent("Tessa Byrne有哪些逾期任务？")).toEqual({ person: "Tessa Byrne" });
    expect(lateIntent("团队里谁落后了？")).toEqual({});
    expect(lateIntent("哪些人有延期的任务？")).toEqual({});
    // Español
    expect(lateIntent("¿Quién tiene tareas atrasadas?")).toEqual({});
    expect(lateIntent("¿Quién está retrasado en el equipo de Ventas?")).toEqual({ department: "Ventas" });
    expect(lateIntent("¿Qué tareas tiene Tessa Byrne atrasadas?")).toEqual({ person: "Tessa Byrne" });
    expect(lateIntent("¿Tessa Byrne tiene tareas vencidas?")).toEqual({ person: "Tessa Byrne" });
    expect(lateIntent("¿Quiénes van atrasados en el equipo?")).toEqual({});
  });
  it("routes finished, project, leave and blocked questions", () => {
    // English
    expect(route("What did Sales finish this week?")).toEqual({ tool: "team_status", input: { person: "Sales" } });
    expect(route("What did the Engineering team finish this week?")).toEqual({ tool: "team_status", input: { department: "Engineering" } });
    expect(route("How is the Customer portal 2.0 project going?")).toEqual({ tool: "project_status", input: { project: "Customer portal 2.0" } });
    expect(route("Who is out today?")?.tool).toBe("who_is_out");
    expect(route("What's blocked?")).toEqual({ tool: "team_status", input: {} });
    // Tiếng Việt
    expect(route("Lily đã làm xong gì tuần này?")).toEqual({ tool: "team_status", input: { person: "Lily" } });
    expect(route("Phòng Marketing tuần này thế nào?")).toEqual({ tool: "team_status", input: { department: "Marketing" } });
    expect(route("Dự án Customer portal 2.0 thế nào?")).toEqual({ tool: "project_status", input: { project: "Customer portal 2.0" } });
    expect(route("Ai đang nghỉ phép?")?.tool).toBe("who_is_out");
    expect(route("Việc nào đang bị chặn?")).toEqual({ tool: "team_status", input: {} });
    // 中文
    expect(route("销售部本周完成了什么？")).toEqual({ tool: "team_status", input: { department: "销售" } });
    expect(route("张伟本周完成了什么？")).toEqual({ tool: "team_status", input: { person: "张伟" } });
    expect(route("Customer portal 2.0项目怎么样？")).toEqual({ tool: "project_status", input: { project: "Customer portal 2.0" } });
    expect(route("今天谁请假了？")?.tool).toBe("who_is_out");
    expect(route("哪些任务被阻塞了？")).toEqual({ tool: "team_status", input: {} });
    // Español
    expect(route("¿Qué terminó Lily esta semana?")).toEqual({ tool: "team_status", input: { person: "Lily" } });
    expect(route("¿Qué terminó el equipo de Ventas esta semana?")).toEqual({ tool: "team_status", input: { department: "Ventas" } });
    expect(route("¿Cómo va el proyecto Customer portal 2.0?")).toEqual({ tool: "project_status", input: { project: "Customer portal 2.0" } });
    expect(route("¿Quién está de vacaciones hoy?")?.tool).toBe("who_is_out");
    expect(route("¿Qué tareas están bloqueadas?")).toEqual({ tool: "team_status", input: {} });
  });
  it("writes the late answer in the asker's language", () => {
    const now = Date.parse("2026-11-02T10:00:00Z");
    expect(renderLate(team, { person: "tessa" }, "zh", now, "UTC").text).toContain("有 2 个逾期任务");
    expect(renderLate(team, { person: "tessa" }, "es", now, "UTC").text).toContain("tiene 2 tareas atrasadas");
    expect(renderLate(team, {}, "en", now, "UTC").text).toMatch(/late tasks \(\d+ in all\)/);
  });
  it("refuses answers built on placeholders or figures the data does not hold", () => {
    expect(groundedIn("Sales closed $XXX in Hà Nội this week.", "[total] 9 people", "What did Sales finish?").ok).toBe(false);
    expect(groundedIn("Revenue grew 23% to $45,000.", "[total] 9 people: 3 done in 7 days", "how is sales").ok).toBe(false);
    expect(groundedIn("9 people, 3 done in 7 days.", "[total] 9 people: 3 done in 7 days", "how is sales").ok).toBe(true);
  });
});

describe("aboutWorkspace", () => {
  it("tells questions about the company's own data from plain chat", () => {
    for (const q of [
      "What did Sales finish this week?",
      "Doanh số tuần này của phòng Sales?",
      "销售团队这周完成了什么？",
      "¿Qué hizo el equipo de ventas esta semana?",
      "How is the Atlas project?",
    ])
      expect(aboutWorkspace(q)).toBe(true);
    for (const q of ["Write a polite email declining a meeting", "Viết email chào khách mới", "解释一下什么是OKR", "Escribe un correo de bienvenida"])
      expect(aboutWorkspace(q)).toBe(false);
  });
});

describe("blocked work and department names", () => {
  it("finds blocked questions in four languages", () => {
    for (const q of ["What's blocked?", "Việc nào đang bị chặn?", "哪些任务被阻塞了？", "¿Qué tareas están bloqueadas?"]) expect(blockedIntent(q)).not.toBeNull();
    expect(blockedIntent("Who is late?")).toBeNull();
  });
  it("lists blocked tasks with who has them and why", () => {
    const t = {
      scope: "everyone" as const,
      people: [
        {
          userId: "u1",
          displayName: "Ben Okafor",
          department: "Engineering",
          overdue: 0,
          open: 2,
          tasks: [{ id: "t9", code: "T-086", title: "Reconciliation", status: "in_progress", dueAt: null, blockedReason: "Waiting for bank API keys" }],
        },
      ],
    };
    const en = renderBlocked(t, {}, "en").text;
    expect(en).toContain("1 task is blocked");
    expect(en).toContain("Waiting for bank API keys");
    expect(renderBlocked(t, {}, "es").text).toContain("1 tarea está bloqueada");
    expect(renderBlocked({ ...t, people: [] }, {}, "zh").text).toContain("没有被阻塞");
  });
  it("matches department names across languages", () => {
    expect(deptMatches("Sales", "销售")).toBe(true);
    expect(deptMatches("Sales", "Ventas")).toBe(true);
    expect(deptMatches("Engineering", "Ingeniería")).toBe(true);
    expect(deptMatches("Engineering", "kỹ thuật")).toBe(true);
    expect(deptMatches("Marketing", "Sales")).toBe(false);
  });
});
