import { describe, expect, it } from "vitest";
import { routeIntent } from "../../src/modules/ai/runtime.js";

const ALL = ["list_my_tasks", "recent_channel_messages", "team_status", "delegated_status", "who_is_out", "my_leave_balance", "search_messages"];
const tool = (q: string, ctx: { channelId?: string } = {}) => routeIntent(q, ALL, ctx)?.tool ?? null;

/** Questions people actually type to @AI, routed to the data that answers them (works without a hosted model). */
describe("intent routing", () => {
  it("my own work", () => {
    expect(tool("@AI việc của tôi tuần này là gì?")).toBe("list_my_tasks");
    expect(tool("hôm nay mình phải làm gì")).toBe("list_my_tasks");
    expect(tool("Hôm nay tôi cần làm những việc gì?")).toBe("list_my_tasks");
    expect(tool("what should I work on today?")).toBe("list_my_tasks");
    expect(tool("Summarise my overdue tasks")).toBe("list_my_tasks");
  });

  it("English questions about people, leave and projects", () => {
    expect(routeIntent("How is Tessa doing?", ALL)).toEqual({ tool: "team_status", input: { person: "Tessa" } });
    expect(routeIntent("What is Liam working on?", ALL)).toEqual({ tool: "team_status", input: { person: "Liam" } });
    expect(routeIntent("how many tasks are overdue for Lily Chen?", ALL)).toEqual({ tool: "team_status", input: { person: "Lily Chen" } });
    expect(routeIntent("Show me Tom Becker's tasks", ALL)).toEqual({ tool: "team_status", input: { person: "Tom Becker" } });
    expect(routeIntent("Tom Becker có việc nào trễ hạn không?", ALL)).toEqual({ tool: "team_status", input: { person: "Tom Becker" } });
    expect(routeIntent("when is the Customer portal 2.0 project due?", [...ALL, "project_status"])?.tool).toBe("project_status");
    expect(tool("How many days of leave do I have left?")).toBe("my_leave_balance");
    expect(tool("Who is off this week?")).toBe("who_is_out");
    expect(routeIntent("Which projects are behind?", [...ALL, "project_status"])?.tool).toBe("project_status");
  });

  it("what I assigned and my team come before my own work", () => {
    expect(tool("việc tôi đã giao tới đâu rồi?")).toBe("delegated_status");
    expect(tool("đội của tôi đang làm gì?")).toBe("team_status");
  });

  it("a channel summary reads the channel it was asked in, and only then", () => {
    expect(routeIntent("@AI tóm tắt kênh này giúp mình", ALL, { channelId: "01JABCDEFGHJKMNPQRSTVWXYZ0" })).toEqual({
      tool: "recent_channel_messages",
      input: { channelId: "01JABCDEFGHJKMNPQRSTVWXYZ0" },
    });
    expect(tool("có gì mới ở đây?", { channelId: "01JABCDEFGHJKMNPQRSTVWXYZ0" })).toBe("recent_channel_messages");
    expect(tool("tóm tắt kênh này")).toBeNull();
  });

  it("leave and who is out", () => {
    expect(tool("tôi còn bao nhiêu ngày phép?")).toBe("my_leave_balance");
    expect(tool("ai đang nghỉ phép hôm nay?")).toBe("who_is_out");
  });

  it("tools outside the allow-list are never chosen", () => {
    expect(routeIntent("việc của tôi là gì", ["search_messages"])).toBeNull();
  });
});

describe("routeIntent · AI usage", () => {
  const all = ["team_status", "team_ai_usage", "delegated_status"];
  it("routes questions about AI use, not 'ai' meaning 'who'", () => {
    expect(routeIntent("Đội tôi dùng ChatGPT làm gì?", all)?.tool).toBe("team_ai_usage");
    expect(routeIntent("Ai sử dụng AI nhiều nhất tuần này?", all)?.tool).toBe("team_ai_usage");
    expect(routeIntent("Có ai dán dữ liệu nhạy cảm không?", all)?.tool).toBe("team_ai_usage");
    expect(routeIntent("Ai đang trễ hạn?", all)?.tool).toBe("team_status");
    expect(routeIntent("Mục tiêu quý này đang thế nào?", [...all, "goals_status"])?.tool).toBe("goals_status");
    expect(routeIntent("Đội của tôi đang làm gì?", all)?.tool).toBe("team_status");
  });
});
