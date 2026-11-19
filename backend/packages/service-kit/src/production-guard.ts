import { logger } from "./logger.js";

/** The placeholders the development defaults use; a production process must never run with them. */
export const DEV_INTERNAL_SECRET = "dev-internal-secret-change-me-32bytes!";

/**
 * Refuses to start a production process on development secrets. Called before a port opens, so a deployment that
 * forgot a secret (a hand-written compose file, Kubernetes) fails loudly instead of signing tokens everyone can
 * forge. `extra` adds module-specific secrets (LiveKit, S3) with their dev defaults.
 * Outside production nothing is checked: the defaults are what `pnpm dev` runs on.
 */
export function assertProductionSecrets(extra: { name: string; devDefault?: string; minLength?: number; when?: boolean }[] = []): void {
  if (process.env.NODE_ENV !== "production") return;
  const checks = [{ name: "INTERNAL_TOKEN_SECRET", devDefault: DEV_INTERNAL_SECRET, minLength: 32 }, ...extra];
  const problems: string[] = [];
  for (const c of checks) {
    if (c.when === false) continue;
    const v = process.env[c.name] ?? "";
    if (!v) problems.push(`${c.name} is not set`);
    else if (c.devDefault && v === c.devDefault) problems.push(`${c.name} still has its development value`);
    else if (c.minLength && v.length < c.minLength) problems.push(`${c.name} must be at least ${c.minLength} characters`);
  }
  if (problems.length) {
    logger.error({ problems }, "refusing to start in production with development secrets");
    throw new Error(`Production secrets missing: ${problems.join("; ")}`);
  }
}
