import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  // The specs read Vietnamese labels; /setup and the sign-in pages follow the browser language, so pin it. `locale`
  // sets the browser's Accept-Language only: the header is given too so calls a spec makes itself (`page.request`)
  // ask for the same language, and what the server names for them (a new board's columns) reads as the page does.
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    locale: "vi-VN",
    extraHTTPHeaders: { "accept-language": "vi-VN,vi;q=0.9" },
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
