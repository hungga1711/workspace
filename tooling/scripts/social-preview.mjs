#!/usr/bin/env node
/**
 * The GitHub social preview: renders docs/assets/social-preview.html with headless Chromium to
 * docs/assets/social-preview.png (1280×640, the size GitHub asks for), uploaded in the repository's
 * Settings › General › Social preview.
 *
 *   node tooling/scripts/social-preview.mjs
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const { chromium } = createRequire(join(root, "frontend/web/package.json"))("@playwright/test");

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(join(root, "docs/assets/social-preview.html")).href);
  await page.evaluate(() => globalThis.document.fonts.ready);
  const out = join(root, "docs/assets/social-preview.png");
  await page.screenshot({ path: out, type: "png" });
  console.log(`saved ${out}`);
} finally {
  await browser.close();
}
