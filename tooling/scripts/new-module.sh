#!/bin/sh
# Scaffolds a module of the backend server (ADR 0021: one process, one folder, schema and role per module).
# Usage (from the repo root): sh tooling/scripts/new-module.sh <module>
#   → backend/server/{src/modules/<module>/start.ts, migrations/<module>/, test/<module>/}
set -e
m="$1"
[ -n "$m" ] || { echo "usage: sh tooling/scripts/new-module.sh <module>" >&2; exit 1; }
d="backend/server"
mkdir -p "$d/src/modules/$m" "$d/migrations/$m" "$d/test/$m"
[ -f "$d/src/modules/$m/start.ts" ] || cat > "$d/src/modules/$m/start.ts" <<TS
import type { RequestListener } from "node:http";
import { join } from "node:path";
import { migrate, type ModuleContext } from "@workspace/service-kit";

/** $m (schema \`$m\`): migrate, build the Nest app, start its events and jobs, return its HTTP handler. */
export async function start$m(ctx: ModuleContext): Promise<RequestListener> {
  await migrate(ctx.ownerUrl, join(ctx.migrations, "$m"), "$m");
  throw new Error("build the $m Nest app here and return app.getHttpAdapter().getInstance()");
}
TS
echo "created $d/src/modules/$m — next: add \"$m\" to MODULE_URLS (backend/packages/service-kit/src/config.ts), start it"
echo "in backend/server/src/main.ts (and its moduleRouter list), add it to tooling/scripts/migrate-all.mjs, and add the"
echo "$m role and schema to both postgres init files (docs/runbooks/local-development.md)."
