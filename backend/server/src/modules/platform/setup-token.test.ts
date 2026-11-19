import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupToken, setupTokenMatches, setupTokenRequired } from "./setup-token.js";

const saved = { NODE_ENV: process.env.NODE_ENV, SETUP_TOKEN: process.env.SETUP_TOKEN, SETUP_TOKEN_FILE: process.env.SETUP_TOKEN_FILE };
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("setup token", () => {
  it("is required in production or when SETUP_TOKEN is set, not in development", () => {
    delete process.env.SETUP_TOKEN;
    process.env.NODE_ENV = "development";
    expect(setupTokenRequired()).toBe(false);
    process.env.SETUP_TOKEN = "abc";
    expect(setupTokenRequired()).toBe(true);
    delete process.env.SETUP_TOKEN;
    process.env.NODE_ENV = "production";
    expect(setupTokenRequired()).toBe(true);
  });

  it("prefers the environment, else generates one into the file once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "setup-token-"));
    process.env.SETUP_TOKEN_FILE = join(dir, "nested", "token");
    process.env.SETUP_TOKEN = "from-env";
    expect(await setupToken()).toBe("from-env");
    delete process.env.SETUP_TOKEN;
    const generated = await setupToken();
    expect(generated).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(readFileSync(process.env.SETUP_TOKEN_FILE, "utf8")).toBe(generated);
    expect(await setupToken()).toBe(generated);
    rmSync(dir, { recursive: true, force: true });
  });

  it("compares in constant length-safe fashion", () => {
    expect(setupTokenMatches("abc", "abc")).toBe(true);
    expect(setupTokenMatches("abd", "abc")).toBe(false);
    expect(setupTokenMatches("ab", "abc")).toBe(false);
    expect(setupTokenMatches(undefined, "abc")).toBe(false);
  });
});
