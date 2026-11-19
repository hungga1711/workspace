import { env, envInt, MODULE_NAMES, moduleUrl, ServiceClient } from "@workspace/service-kit";
import { createGateway } from "./gateway.js";
import { demoConfigFromEnv } from "./demo.js";

/**
 * The public edge: sign-in sessions, workspace resolution, rate limits, routing `/api/<module>/…`.
 * Every module lives in this process, so the calls to them are in-memory (`serviceFetch`).
 */
export function startGateway() {
  const secret = env("INTERNAL_TOKEN_SECRET", "dev-internal-secret-change-me-32bytes!");
  return createGateway({
    jwksUrl: `${moduleUrl("identity")}/internal/auth/jwks`,
    internalSecret: secret,
    identity: new ServiceClient(moduleUrl("identity"), secret, "gateway", [
      { permission: "principal.resolve", scope: "PLATFORM" },
      { permission: "account.recover", scope: "PLATFORM" },
      { permission: "auth.session", scope: "PLATFORM" },
    ]),
    platform: new ServiceClient(moduleUrl("platform"), secret, "gateway", [
      { permission: "workspace.signup", scope: "PLATFORM" },
      { permission: "principal.resolve", scope: "PLATFORM" },
    ]),
    work: new ServiceClient(moduleUrl("work"), secret, "gateway", [{ permission: "principal.resolve", scope: "PLATFORM" }]),
    ai: new ServiceClient(moduleUrl("ai"), secret, "gateway", [{ permission: "principal.resolve", scope: "PLATFORM" }]),
    services: Object.fromEntries(MODULE_NAMES.map((m) => [m, moduleUrl(m)])),
    rateLimit: {
      userPerMinute: envInt("RATE_USER_PER_MIN", 600),
      signupPerIpPerHour: envInt("RATE_SIGNUP_PER_HOUR", 10),
      recoveryPerIpPerHour: envInt("RATE_RECOVERY_PER_HOUR", 20),
      ssrReadsPerMinute: envInt("RATE_SSR_READS_PER_MIN", envInt("RATE_USER_PER_MIN", 600) * 5),
    },
    trustProxy: process.env.TRUST_PROXY ?? "loopback",
    apiDocs: process.env.API_DOCS === "1",
    demo: demoConfigFromEnv(),
    // Where MCP clients reach this installation (the OAuth metadata names them); the app first.
    publicOrigins: [process.env.APP_URL, process.env.PUBLIC_API_URL]
      .flatMap((u) => {
        try {
          return u ? [new URL(u).origin] : [];
        } catch {
          return [];
        }
      })
      .filter((u, i, a) => a.indexOf(u) === i),
  });
}
