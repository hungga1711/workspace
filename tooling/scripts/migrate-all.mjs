// Applies every module's migrations to its schema of the one `workspace` database, as the owner role.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { migrate } from "../../backend/packages/service-kit/dist/index.js";

// WORKSPACE_ROOT: set by the production image, where this script runs as a bundle away from tooling/scripts/.
const root = process.env.WORKSPACE_ROOT ?? resolve(import.meta.dirname, "../..");
// The owner role on the workspace database (the image falls back to OWNER_DATABASE_URL; default: local dev).
const url = process.env.MIGRATE_DATABASE_URL ?? process.env.OWNER_DATABASE_URL ?? "postgres://workspace_owner:owner_pw@localhost:5432/workspace";
// backend/server/migrations/<schema>/ (ADR 0021); `web` is the web app's session store.
const schemas = ["identity", "platform", "search", "chat", "home", "work", "employee", "ai", "web"];
for (const schema of schemas) {
  const dir = join(root, "backend/server/migrations", schema);
  if (!existsSync(dir)) continue;
  const applied = await migrate(url, dir, schema);
  console.log(`${schema}: ${applied.length ? applied.join(", ") : "up to date"}`);
}
