import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";
// @ts-expect-error a plain .mjs tooling script, typed by use
import { testDatabaseEnv } from "../../tooling/scripts/test-db.mjs";

// Tests never send real email, even when the developer's .env has SMTP_URL: emails land as files (readOutbox).
// They run on their own database (workspace_test, created and migrated by globalSetup), never the development one,
// and each file starts from an empty installation (reset-each-file.ts).
export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    globalSetup: ["./test/global-setup.ts"],
    setupFiles: ["./test/reset-each-file.ts"],
    env: { SMTP_URL: "", MAIL_OUTBOX_DIR: join(tmpdir(), "workspace-test-mail"), ...(testDatabaseEnv() as Record<string, string>) },
  },
});
