import { describe, expect, it } from "vitest";
import { READ_TOOLS, routeIntent } from "./runtime.js";
import { areasOf, selectTools } from "./tool-select.js";

const route = (q: string) => routeIntent(q, READ_TOOLS)?.tool ?? null;

describe("routeIntent without accents", () => {
  it("Vietnamese typed without accents reads like the accented question", () => {
    const pairs: [string, string][] = [
      ["tôi bỏ lỡ gì", "toi bo lo gi"],
      ["ai đang quá tải?", "ai dang qua tai?"],
      ["sơ đồ tổ chức công ty", "so do to chuc cong ty"],
      ["việc gì đang chờ tôi xử lý", "viec gi dang cho toi xu ly"],
      ["báo cáo tuần", "bao cao tuan"],
      ["còn mấy ngày phép", "con may ngay phep"],
      ["hôm nay tôi nên làm gì trước?", "hom nay toi nen lam gi truoc?"],
    ];
    for (const [accented, plain] of pairs) {
      const want = route(accented);
      expect(want, accented).not.toBeNull();
      expect(route(plain), plain).toBe(want);
    }
  });

  it("a person's name typed without accents is still found", () => {
    expect(routeIntent("Lan dang lam gi", READ_TOOLS)).toEqual({ tool: "team_status", input: { person: "Lan" } });
  });

  it("accented questions are routed as before; English is unchanged", () => {
    expect(route("what did I miss")).toBe("summarize_channel");
    expect(route("who is overloaded")).toBe("workload_balance");
    expect(route("write me a poem")).toBeNull();
  });
});

describe("routeIntent: a day's plan and an end-of-day report", () => {
  it("'what should I do first' is the day in order, the plain list stays the plain list", () => {
    expect(route("Hôm nay tôi nên làm gì trước?")).toBe("plan_my_day");
    expect(route("toi nen lam gi truoc")).toBe("plan_my_day");
    expect(route("Plan my day")).toBe("plan_my_day");
    expect(route("What should I do first?")).toBe("plan_my_day");
    expect(route("my tasks")).toBe("list_my_tasks");
  });

  it("an end-of-day report is drafted from the day's work", () => {
    expect(routeIntent("Viết báo cáo cuối ngày giúp tôi", READ_TOOLS)).toEqual({ tool: "draft_update", input: { kind: "end_of_day" } });
    expect(routeIntent("draft my end-of-day update", READ_TOOLS)).toEqual({ tool: "draft_update", input: { kind: "end_of_day" } });
  });
});

describe("tool selection for the day's help", () => {
  it("planning and drafting words bring the assist tools; other questions do not", () => {
    expect(areasOf("toi nen lam gi truoc").has("assist")).toBe(true);
    expect(areasOf("draft an update for T-12").has("assist")).toBe(true);
    const names = ["search_workspace", "plan_my_day", "draft_update"];
    expect([...selectTools(names, "what is the refund policy?")]).toEqual(["search_workspace"]);
    expect([...selectTools(names, "plan my day")]).toEqual(names);
  });
});
