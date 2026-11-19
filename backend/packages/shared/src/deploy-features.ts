/**
 * Features an installation can leave out at deploy time (ADR 0026): `DISABLED_FEATURES=whiteboards,calendar` in
 * the server's environment. Chat, tasks, Home, sign-in and Admin are the product and have no flag. A switched-off
 * feature keeps its tables and data: removing the name from the list brings it back as it was.
 *
 * This list is the only definition. The platform module publishes each flag in the workspace's `features`
 * (`docs: false`), which is all the web app reads; server code (the gateway's routes, a module's jobs) asks
 * `featureDisabled()` here. Nothing else parses the variable.
 */
export const DEPLOY_FEATURES = ["docs", "whiteboards", "calendar", "time", "ai"] as const;
export type DeployFeature = (typeof DEPLOY_FEATURES)[number];

export const DISABLED_FEATURES_ENV = "DISABLED_FEATURES";

/** Names people write for a flag (the nav label, the singular) that mean one of ours. */
const ALIASES: Record<string, DeployFeature> = {
  doc: "docs",
  documents: "docs",
  whiteboard: "whiteboards",
  attendance: "time",
  timekeeping: "time",
};

/**
 * Reads the variable's value: names separated by commas or spaces, any case. Unknown names are returned apart so
 * the caller can warn about them: a typo must never stop the server, and never switch anything off.
 */
export function parseDisabledFeatures(raw: string | undefined | null): { disabled: Set<DeployFeature>; unknown: string[] } {
  const disabled = new Set<DeployFeature>();
  const unknown: string[] = [];
  for (const word of (raw ?? "").split(/[\s,;]+/)) {
    const name = word.trim().toLowerCase();
    if (!name) continue;
    const feature = (DEPLOY_FEATURES as readonly string[]).includes(name) ? (name as DeployFeature) : ALIASES[name];
    if (feature) disabled.add(feature);
    else if (!unknown.includes(name)) unknown.push(name);
  }
  return { disabled, unknown };
}

/** The features this process runs without. Read on every call: tests set the variable per case, and it is cheap. */
export function disabledFeatures(env: NodeJS.ProcessEnv = process.env): Set<DeployFeature> {
  return parseDisabledFeatures(env[DISABLED_FEATURES_ENV]).disabled;
}

export function featureDisabled(feature: DeployFeature, env: NodeJS.ProcessEnv = process.env): boolean {
  return disabledFeatures(env).has(feature);
}

/** Every flag as the workspace's `features` carries it: `true` unless the deployment left the feature out. */
export function deployFeatureMap(env: NodeJS.ProcessEnv = process.env): Record<DeployFeature, boolean> {
  const off = disabledFeatures(env);
  return Object.fromEntries(DEPLOY_FEATURES.map((f) => [f, !off.has(f)])) as Record<DeployFeature, boolean>;
}
