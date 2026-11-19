// Copies the whiteboard editor's fonts from @excalidraw/excalidraw into public/excalidraw/fonts/, so the app serves
// them itself (no CDN: offline self-hosting and a 'self'-only CSP). Runs after install (package.json "postinstall",
// which the Docker image build runs too) and before `dev`/`build`; it is quick and idempotent.
//
// Only fonts whose licence ships with the file are copied (their licence texts are committed next to them):
// Nunito, Virgil, Lilita One, Cascadia Code (OFL 1.1) and Comic Shanns (MIT). Left out: Xiaolai (12 MB of CJK
// glyphs), Excalifont and Liberation Sans (no licence in the font files). A board that uses one of those falls back
// to the system font.
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const FAMILIES = ["Nunito", "Virgil", "Lilita", "Cascadia", "ComicShanns"];
const web = join(import.meta.dirname, "..");
let from;
try {
  // The package exports only its entry (dist/prod/index.js); the fonts sit beside it.
  from = join(dirname(createRequire(join(web, "package.json")).resolve("@excalidraw/excalidraw")), "fonts");
} catch {
  // Not installed (a partial install): nothing to copy.
  process.exit(0);
}
const to = join(web, "public", "excalidraw", "fonts");
let copied = 0;
for (const family of FAMILIES) {
  const src = join(from, family);
  if (!existsSync(src)) continue;
  mkdirSync(join(to, family), { recursive: true });
  for (const f of readdirSync(src).filter((n) => n.endsWith(".woff2"))) {
    copyFileSync(join(src, f), join(to, family, f));
    copied++;
  }
}
if (process.argv.includes("--verbose")) console.log(`excalidraw-assets: ${copied} font files → public/excalidraw/fonts`);
