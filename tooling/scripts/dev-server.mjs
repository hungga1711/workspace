// Starts the backend server (backend/server/src/main.ts, every module in one process) with tsx and the root .env,
// restarting it when its code or a shared package changes (WATCH=0 turns that off).
//   :4000 public (gateway /api, Socket.IO /socket.io, local files /storage)   :4001 module APIs (127.0.0.1)
//
// Watching uses Node's watch mode on the source folders, not `tsx watch`: on macOS tsx opens one watcher per
// imported file's folder, node_modules included (~20,000 handles), which exhausts the system's file watchers and
// makes `next dev` fail with EMFILE. WATCH=tsx uses `tsx watch` anyway.
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
// Local secrets and AI routing (see .env.example). Values already exported in the shell win.
try {
  process.loadEnvFile(join(root, ".env"));
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
const tsx = join(root, "node_modules/.bin/tsx");
// Shared code the server imports: changes there restart it too.
const packageSources = readdirSync(join(root, "backend/packages"))
  .map((p) => join(root, "backend/packages", p, "src"))
  .filter((d) => existsSync(d));

// Run from the package directory so tsx picks up its tsconfig (decorators).
const appDir = join(root, "backend/server");
const entry = join(appDir, "src/main.ts");
const mode = process.env.WATCH === "0" ? "off" : process.env.WATCH === "tsx" ? "tsx" : "node";
const [cmd, args] =
  mode === "tsx"
    ? [tsx, ["watch", "--clear-screen=false", entry]]
    : [
        process.execPath,
        [...(mode === "node" ? [join(appDir, "src"), ...packageSources].flatMap((d) => [`--watch-path=${d}`]).concat("--watch-preserve-output") : []), "--import", "tsx", entry],
      ];
// TEST_SERVER=1 (tooling/scripts/test-db.mjs --serve) keeps the test installation's own ports; otherwise :4000.
const port = process.env.TEST_SERVER === "1" ? (process.env.PORT ?? "4100") : "4000";
const child = spawn(cmd, args, { cwd: appDir, env: { SERVICE_NAME: "server", ...process.env, PORT: port }, stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));

const stop = () => child.kill("SIGTERM");
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
