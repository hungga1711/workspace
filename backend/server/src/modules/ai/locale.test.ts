import { describe, expect, it } from "vitest";
import { dataLang, detectLocale, replyIn, replyLocale, requestLocale } from "./locale.js";
import { replyLanguage } from "./runtime.js";

const req = (l?: string) => ({ headers: l ? { "x-locale": l } : {} });

describe("answer language", () => {
  it("reads the interface language, English when unknown", () => {
    expect(requestLocale(req("en"))).toBe("en");
    expect(requestLocale(req("vi"))).toBe("vi");
    expect(requestLocale(req("zh-CN"))).toBe("zh");
    expect(requestLocale(req("es-MX"))).toBe("es");
    expect(requestLocale(req("fr"))).toBe("en");
    expect(requestLocale(req())).toBe("en");
  });
  it("detects the question's own language", () => {
    expect(detectLocale("What did Sales finish this week?")).toBe("en");
    expect(detectLocale("Ai đang trễ việc ở Engineering?")).toBe("vi");
    expect(detectLocale("工程部谁的任务逾期了？")).toBe("zh");
    expect(detectLocale("¿Quién tiene tareas atrasadas?")).toBe("es");
    expect(detectLocale("qué terminó el equipo de ventas esta semana")).toBe("es");
    expect(detectLocale("T-104")).toBeNull();
  });
  it("prefers the question, then the interface language", () => {
    expect(replyLocale("T-104", req("es"))).toBe("es");
    expect(replyLocale("Who is late?", req("vi"))).toBe("en");
  });
  it("names each language in prompts; tool data stays English or Vietnamese", () => {
    expect(replyIn("en")).toBe("Reply in English.");
    expect(replyIn("vi")).toBe("Reply in Vietnamese.");
    expect(replyIn("zh")).toBe("Reply in Simplified Chinese.");
    expect(replyIn("es")).toBe("Reply in Spanish.");
    expect(replyLanguage(req("en"))).toBe("English");
    expect(replyLanguage(req("zh"))).toBe("Simplified Chinese");
    expect(dataLang("zh")).toBe("en");
    expect(dataLang("vi")).toBe("vi");
  });
});
