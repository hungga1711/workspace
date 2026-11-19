export const config = {
  appUrl: process.env.APP_URL ?? "http://localhost:3000",
  gatewayUrl: process.env.GATEWAY_URL ?? "http://localhost:4000",
  /**
   * Where API-key clients reach the API from outside (shown in Admin › Integrations): the API domain when one is set,
   * else the app's own URL (requests carrying a wos_ key are sent on to the server there, next.config + Caddy).
   */
  publicGatewayUrl: process.env.PUBLIC_API_URL || process.env.APP_URL || "http://localhost:3000",
  // Development default; the Docker image refuses to start the web app without SESSION_SECRET (web-config.mjs).
  sessionSecret: process.env.SESSION_SECRET ?? "dev-session-secret-change-me-32-bytes!!",
  /** The public demo (infra/demo): banner and quick sign-in buttons. The gateway enforces the locks on its own. */
  demoMode: process.env.DEMO_MODE === "1",
};
