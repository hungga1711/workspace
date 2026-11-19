import type { RequestListener } from "node:http";
import type { ModuleName } from "./config.js";
import type { EventBus } from "./events.js";

/** What the server gives each module it hosts. */
export interface ModuleContext {
  /** The owner role on a direct connection: migrations, the outbox relay's LISTEN, job locks. */
  ownerUrl: string;
  /** The process's event bus (in memory), shared by its modules; outbox relays deliver through it. */
  bus: EventBus;
  /**
   * The server's `migrations/` directory (one sub-directory per module schema). Resolved once by the
   * server's main file, so it holds both for compiled sources and for the single-file production bundle.
   */
  migrations: string;
}

export interface HostedModule {
  name: ModuleName;
  handler: RequestListener;
}

const json = (status: number, body: unknown): [number, Record<string, string>, string] => [status, { "content-type": "application/json" }, JSON.stringify(body)];

/**
 * One HTTP listener for the modules the server hosts (ADR 0021), on its internal port. `/<module>/…` reaches that
 * module with the prefix removed, so module routes do not know their prefix; `/health` answers for the process.
 * In-process calls between modules do not come through here: the server registers each module with
 * `serveInProcess` as soon as it has started.
 */
export function moduleRouter(modules: HostedModule[]): RequestListener {
  const byPrefix = new Map(modules.map((m) => [`/${m.name}`, m.handler]));
  return (req, res) => {
    const url = req.url ?? "/";
    const path = url.split("?")[0]!;
    if (path === "/health") {
      const [status, headers, body] = json(200, { ok: true, modules: modules.map((m) => m.name) });
      return void res.writeHead(status, headers).end(body);
    }
    const prefix = `/${path.split("/")[1] ?? ""}`;
    const handler = byPrefix.get(prefix);
    if (typeof handler !== "function") {
      const [status, headers, body] = json(404, { error: "not found" });
      return void res.writeHead(status, headers).end(body);
    }
    const rest = url.slice(prefix.length);
    req.url = rest.startsWith("/") ? rest : `/${rest}`;
    handler(req, res);
  };
}
