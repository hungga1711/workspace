import "server-only";
import { cache } from "react";
import { notFound } from "next/navigation";
import { gw } from "./gateway";
import type { Feature } from "./feature-links";

/**
 * The installation's workspace as the platform module describes it (`GET /workspace`), read once per request: the
 * app layout and any page that needs the workspace share this one call.
 */
export const workspaceInfo = cache(<T extends { features?: Record<string, boolean> }>(): Promise<T> => gw<T>("/api/platform/workspace"));

/** The features as last read: they only change when the server restarts, so a failed read keeps the last answer. */
let last: Record<string, boolean> | null = null;

/**
 * Whether a feature a deployment can leave out (`DISABLED_FEATURES` on the server, ADR 0026) is part of this
 * installation. The server is the only one that reads the variable; the web follows the workspace's `features`.
 * Unknown (the server did not answer and nothing was read before) counts as on: the page shows its own load error,
 * and the gateway refuses the feature's routes whatever the web shows.
 */
export async function featureOn(feature: Feature): Promise<boolean> {
  const features = await workspaceInfo().then(
    (w) => (last = w.features ?? {}),
    () => last ?? {},
  );
  return features[feature] !== false;
}

/** For a page or layout of an optional feature: the address does not exist when the deployment left it out. */
export async function requireFeature(feature: Feature): Promise<void> {
  if (!(await featureOn(feature))) notFound();
}
