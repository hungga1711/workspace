import { timingSafeEqual } from "node:crypto";

/**
 * The public demo (`DEMO_MODE=1`, infra/demo): anyone on the internet signs in as the seeded owner, a manager or a
 * staff member, and the whole database is restored from the seed snapshot every hour. What stays open is everything
 * a visitor needs to try the product; what is locked is what would spoil the demo for the next visitor before the
 * reset (deleting people or data, taking over the accounts), reach outside (emails to arbitrary addresses, webhooks,
 * AI connections that call out), or hand out credentials (API keys). The gateway enforces it; the web only
 * explains it.
 */

export type DemoRole = "owner" | "manager" | "staff";
export const DEMO_ROLES: readonly DemoRole[] = ["owner", "manager", "staff"];

export interface DemoConfig {
  accounts: Record<DemoRole, { email: string; password: string }>;
  /** Every /api request per visitor IP and minute (the normal limits are per user, and here everyone shares three). */
  perIpPerMinute: number;
  /** Lets the demo seed through the locks (DEMO_SEED_SECRET); empty means nothing gets through. */
  seedSecret?: string;
}

/** Writes refused in the demo: [method, module, module-relative path]. Reads always pass. */
const LOCKED: [RegExp, string, RegExp][] = [
  // People and accounts: no removing, disabling or taking over the shared demo accounts.
  [/^(POST|PUT|PATCH|DELETE)$/, "identity", /^\/members\/[^/]+\/(disable|enable|password\/reset|mfa\/reset|sessions\/logout)$/],
  [/^DELETE$/, "identity", /^\/members\/[^/]+\/invite$/],
  // Invitations send email to any address someone types: an open relay in a public demo.
  [/^POST$/, "identity", /^\/members\/(invite|invite\/bulk|[^/]+\/invite\/resend)$/],
  [/^POST$/, "identity", /^\/workspace\/owner$/],
  [/^(POST|PUT|PATCH|DELETE)$/, "identity", /^\/me\/(password|mfa)(\/|$)/],
  [/^PUT$/, "identity", /^\/security\/mfa-policy$/],
  // Credentials.
  [/^(POST|PUT|PATCH|DELETE)$/, "identity", /^\/api-keys(\/|$)/],
  [/^(POST|PUT|PATCH|DELETE)$/, "identity", /^\/me\/api-keys(\/|$)/],
  // Outbound calls to addresses the visitor chooses.
  [/^(POST|PUT|PATCH|DELETE)$/, "platform", /^\/workspace\/webhooks(\/|$)/],
  [/^(POST|PUT|PATCH|DELETE)$/, "ai", /^\/connections(\/|$)/],
  // External MCP servers: outbound calls and sign-ins to addresses the visitor chooses.
  [/^(POST|PUT|PATCH|DELETE)$/, "ai", /^\/mcp\/(servers|check)(\/|$)/],
  // Deleting the AI Insights data everyone came to see.
  [/^DELETE$/, "ai", /^\/monitor\/data$/],
  [/^POST$/, "ai", /^\/oversight\/erasure-requests\/[^/]+$/],
  // Removing what the AI Insights pages are made of: company keywords and topics, shared prompts. Adding and
  // editing stay open to try; the hourly reset brings the seeded ones back either way.
  [/^DELETE$/, "ai", /^\/(policy\/keywords|insights\/topics|insights\/library)\/[^/]+$/],
  // Provider-export imports and their undo (bulk uploads, like the work and chat imports below).
  [/^(POST|DELETE)$/, "ai", /^\/insights\/imports(\/|$)/],
  // The weekly report email goes out to the admins on its own every Monday.
  [/^PUT$/, "ai", /^\/insights\/report\/settings$/],
  // Bulk imports: large uploads nobody needs to try on a shared instance.
  [/^POST$/, "work", /^\/projects\/[^/]+\/import$/],
  [/^POST$/, "chat", /^\/imports(\/|$)/],
];

export function demoLocked(method: string, service: string, path: string): boolean {
  const q = path.indexOf("?");
  const p = q < 0 ? path : path.slice(0, q);
  return LOCKED.some(([m, s, re]) => m.test(method) && s === service && re.test(p));
}

/**
 * Public routes (no session) that do not exist in the demo: recovering or re-activating the demo accounts. Signup stays: one installation takes one workspace, so after the seed it already answers 409.
 */
export const DEMO_LOCKED_PUBLIC = ["/api/auth/password-reset", "/api/auth/password-set", "/api/auth/token"];

/**
 * The seed (infra/demo) runs through the same gateway and needs what visitors may not do (inviting the members,
 * activating them): it sends `x-demo-seed` with DEMO_SEED_SECRET, which never leaves the server.
 */
export const DEMO_SEED_HEADER = "x-demo-seed";
export function demoSeeding(cfg: DemoConfig, header: string | undefined): boolean {
  return !!cfg.seedSecret && !!header && header.length === cfg.seedSecret.length && timingSafeEqual(Buffer.from(header), Buffer.from(cfg.seedSecret));
}

export const DEMO_LOCKED_BODY = { error: "demo_locked", message: "Disabled in the public demo." };

/**
 * `DEMO_MODE=1` plus the three accounts the seed created (infra/demo sets them). Anything missing turns the demo
 * off rather than half on: quick sign-in needs every password.
 */
export function demoConfigFromEnv(e: NodeJS.ProcessEnv = process.env): DemoConfig | null {
  if (e.DEMO_MODE !== "1") return null;
  const memberPassword = e.DEMO_PASSWORD ?? "";
  const accounts: DemoConfig["accounts"] = {
    owner: { email: e.DEMO_OWNER_EMAIL ?? "admin@example.com", password: e.DEMO_OWNER_PASSWORD ?? "" },
    manager: { email: e.DEMO_MANAGER_EMAIL ?? "minh@example.com", password: memberPassword },
    staff: { email: e.DEMO_STAFF_EMAIL ?? "bao@example.com", password: memberPassword },
  };
  if (DEMO_ROLES.some((r) => !accounts[r].password)) throw new Error("DEMO_MODE=1 needs DEMO_OWNER_PASSWORD and DEMO_PASSWORD (the passwords the demo seed used)");
  return { accounts, perIpPerMinute: Number(e.DEMO_RATE_PER_IP_PER_MIN ?? 120), ...(e.DEMO_SEED_SECRET ? { seedSecret: e.DEMO_SEED_SECRET } : {}) };
}
