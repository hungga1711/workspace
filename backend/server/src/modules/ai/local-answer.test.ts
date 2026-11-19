import { describe, expect, it } from "vitest";
import { LocalProvider } from "./providers.js";

const ask = async (question: string, data: string, searched = false) =>
  (
    await new LocalProvider().generate({
      tier: "smart",
      system: "You are the company's AI assistant at work. Reply in Vietnamese.",
      messages: [
        {
          role: "user",
          content: `${question}\n\n${searched ? "Search results from the workspace. They may be unrelated.\n" : ""}<untrusted_content>\n${data}\n</untrusted_content>`,
        },
      ],
      maxTokens: 500,
    })
  ).text;

describe("the built-in model on one tool's answer", () => {
  it("reads a routed tool's table, tree or report whole, not only its labelled first line", async () => {
    const t = await ask(
      "Ai đang quá tải?",
      "[khối lượng] 2 người, trung vị 2 việc mở mỗi người. tên | mở | trễ | mức tải\nLan Nguyễn (Kỹ thuật) | 5 | 1 | QUÁ TẢI\nAn Phạm (Kinh doanh) | 1 | 0 | còn trống",
    );
    expect(t).toContain("Lan Nguyễn (Kỹ thuật)");
    expect(t).toContain("QUÁ TẢI");
    const report = await ask("Viết báo cáo tuần", "# Báo cáo tuần: đội của tôi\n\n**4 người** · xong 3 việc\n\n## Cần chú ý\n- **Lan Nguyễn**: 1 trễ hạn");
    expect(report).toContain("4 người · xong 3 việc");
    expect(report).toContain("Lan Nguyễn: 1 trễ hạn");
    expect(report).not.toContain("*");
  });

  it("still takes only the labelled lines of search results", async () => {
    const t = await ask("chính sách hoàn tiền", "[document] Refund policy: within 30 days\nloose text that is not a result", true);
    expect(t).not.toContain("loose text");
  });
});
