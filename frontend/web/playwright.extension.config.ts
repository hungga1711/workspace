import { defineConfig } from "@playwright/test";

/**
 * The browser extension on its own (pnpm test:ext): Chromium headless with frontend/browser-extension loaded
 * unpacked, a fake AI chat page and a fake workspace. Needs no running app, so it is not part of the e2e suite.
 */
export default defineConfig({
  testDir: "e2e-extension",
  timeout: 90_000,
  workers: 1,
  reporter: "list",
});
