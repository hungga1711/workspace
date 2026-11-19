/**
 * Server-side error tracking: every uncaught render/route/action error becomes one structured log line on stdout.
 * The digest is what the user sees on the error screen, so a support ticket leads straight to the log line.
 */
export function onRequestError(err: unknown, request: { path: string; method: string }, context: { routerKind: string; routePath: string; routeType: string }) {
  const e = err as Error & { digest?: string };
  console.error(
    JSON.stringify({
      type: "server_error",
      digest: e.digest ?? null,
      name: e.name,
      message: String(e.message).slice(0, 500),
      stack: String(e.stack ?? "")
        .split("\n")
        .slice(0, 8)
        .join("\n"),
      method: request.method,
      path: request.path.split("?")[0],
      route: context.routePath,
      routeType: context.routeType,
      at: new Date().toISOString(),
    }),
  );
}
