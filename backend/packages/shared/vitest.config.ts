import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    // Integration tests share one Postgres; run files serially.
    fileParallelism: false,
    testTimeout: 15_000,
  },
});
