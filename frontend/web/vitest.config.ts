import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** Unit tests for pure helpers in src/lib (browser flows are covered by Playwright in e2e/). */
export default defineConfig({
  // React 19's automatic JSX runtime, as Next compiles it (tsconfig says "preserve" for Next's own compiler).
  esbuild: { jsx: "automatic" },
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { include: ["src/**/*.test.ts"], environment: "node" },
});
