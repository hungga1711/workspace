import { describe, expect, it } from "vitest";
import { browserLocale } from "./config";

describe("browserLocale", () => {
  it("takes the browser's most preferred of our languages", () => {
    expect(browserLocale("en-US,en;q=0.9,vi;q=0.8")).toBe("en");
    expect(browserLocale("vi-VN,vi;q=0.9,en-US;q=0.8")).toBe("vi");
    expect(browserLocale("fr-FR,fr;q=0.9,vi;q=0.5,en;q=0.7")).toBe("en");
  });
  it("is null when the browser lists neither, or sends nothing", () => {
    expect(browserLocale("fr-FR,de;q=0.8")).toBeNull();
    expect(browserLocale(null)).toBeNull();
    expect(browserLocale("")).toBeNull();
    expect(browserLocale("en;q=0")).toBeNull();
  });
});

describe("browserLocale for Chinese and Spanish", () => {
  it("matches any region of the language", () => {
    expect(browserLocale("zh-CN,zh;q=0.9")).toBe("zh");
    expect(browserLocale("zh-TW")).toBe("zh");
    expect(browserLocale("zh-Hans-CN,en;q=0.5")).toBe("zh");
    expect(browserLocale("es-MX,es;q=0.9,en;q=0.8")).toBe("es");
    expect(browserLocale("fr-FR,es;q=0.6,en;q=0.5")).toBe("es");
  });
});
