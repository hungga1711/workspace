"use client";

import { createContext, useCallback, useContext } from "react";
import type { Feature } from "./feature-links";

export { featureOfHref, type Feature } from "./feature-links";

/**
 * The workspace's `features` for client components, set once in the app layout from the platform's answer (no
 * client fetch). A feature is on unless the server said `false`, so outside the provider everything shows.
 */
const Ctx = createContext<Record<string, boolean>>({});

export function FeaturesProvider({ features, children }: { features: Record<string, boolean>; children: React.ReactNode }) {
  return <Ctx.Provider value={features}>{children}</Ctx.Provider>;
}

/** Whether this installation has the feature: hide its links, buttons and menu items when it does not. */
export function useFeature(feature: Feature): boolean {
  return useContext(Ctx)[feature] !== false;
}

/** For lists filtered by feature (navigation, the create menu, the command palette). */
export function useFeatures(): (feature: Feature | null | undefined) => boolean {
  const features = useContext(Ctx);
  return useCallback((feature) => !feature || features[feature] !== false, [features]);
}
