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
    // The same Vietnamese company keeps Vietnamese time: /setup takes the browser's zone for the workspace, and the
    // specs' dates and "Theo công ty" labels are written for it, whatever zone the machine running them is in.
    timezoneId: "Asia/Ho_Chi_Minh",
    extraHTTPHeaders: { "accept-language": "vi-VN,vi;q=0.9" },
    headless: true,
    // Headless Chromium on Linux reports no mouse (hover: none), and Tailwind's hover variants only apply with one, so
    // the message toolbar never showed on CI. The specs drive a desktop with a mouse; say so.
    launchOptions: { args: ["--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4"] },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
