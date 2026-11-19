import { describe, expect, it } from "vitest";
import { logoMatches } from "./logo.js";

const svg = (body: string) => Buffer.from(`<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${body}</svg>`);

describe("logoMatches", () => {
  it("accepts a raster image only with its own signature", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    expect(logoMatches("image/png", png)).toBe(true);
    expect(logoMatches("image/jpeg", png)).toBe(false);
    expect(logoMatches("image/png", Buffer.from("<html></html>"))).toBe(false);
  });
  it("accepts a plain SVG and refuses scripts, handlers and outside references", () => {
    expect(logoMatches("image/svg+xml", svg('<rect width="10" height="10" fill="#163B7A"/>'))).toBe(true);
    expect(logoMatches("image/svg+xml", svg("<script>alert(1)</script>"))).toBe(false);
    expect(logoMatches("image/svg+xml", svg('<rect onload="alert(1)"/>'))).toBe(false);
    expect(logoMatches("image/svg+xml", svg('<image href="https://evil.example/x.png"/>'))).toBe(false);
    expect(logoMatches("image/svg+xml", Buffer.from("<html><svg></svg></html>"))).toBe(false);
  });
});
