import { describe, expect, it } from "vitest";
import { needsWeb, outsideUrls, webNeed } from "./web-need.js";

describe("webNeed", () => {
  it("asks for a web search in vi (with and without accents), en, zh, es", () => {
    for (const q of [
      "Tìm trên mạng: Next.js 15 có gì mới?",
      "tim tren mang gia vang hom nay",
      "Tin tức mới về luật thuế",
      "Đối thủ của mình đang làm gì?",
      "Search the web for the latest React release",
      "What do our competitors charge?",
      "搜索一下最新的新闻",
      "Buscar en internet el precio actual del cobre",
    ])
      expect(webNeed(q).search, q).toBe(true);
  });

  it("leaves ordinary questions alone, so they stay as fast as before", () => {
    for (const q of [
      "Ai đang quá tải?",
      "Việc nào đang trễ hạn?",
      "toi bo lo gi",
      "Tin nhắn mới nhất trong kênh design",
      "What did Lan finish this week?",
      "Họp online lúc mấy giờ?",
    ]) {
      const n = webNeed(q);
      expect(needsWeb(n), q).toBe(false);
    }
  });

  it("reads a linked page, never the app's own screens or a private address", () => {
    expect(webNeed("Tóm tắt trang https://example.com").fetch).toBe(true);
    expect(webNeed("Tóm tắt trang https://example.com.").urls).toEqual(["https://example.com/"]);
    expect(webNeed("Xem http://localhost:3000/app/work/tasks/T-036").fetch).toBe(false);
    expect(webNeed("Mở https://work.acme.vn/app/docs/D-1").fetch).toBe(false);
    expect(outsideUrls("http://192.168.1.4/admin and http://10.0.0.1 and https://a.example/x")).toEqual(["https://a.example/x"]);
  });

  it("turns the code sandbox on for a spreadsheet, and for a document only when asked to compute", () => {
    expect(webNeed("Tổng doanh thu theo tháng?", ["doanh-thu.xlsx"]).code).toBe(true);
    expect(webNeed("Đọc giúp", ["data.csv"]).code).toBe(true);
    expect(webNeed("Tóm tắt hợp đồng này", ["hop-dong.docx"]).code).toBe(false);
    expect(webNeed("Tính tổng các khoản trong báo giá", ["bao-gia.pdf"]).code).toBe(true);
    expect(webNeed("Tóm tắt", ["notes.txt"]).code).toBe(false);
  });
});
