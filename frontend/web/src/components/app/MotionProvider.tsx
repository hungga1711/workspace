"use client";

import { LazyMotion, MotionConfig } from "motion/react";

const features = () => import("./motionFeatures").then((m) => m.default);

/**
 * Motion (motion.dev) for the signed-in app. Only the small `m` components ship with the page; the
 * animation engine loads in its own chunk afterwards (`strict` rejects the heavier `motion.*`).
 * People who ask their OS for reduced motion get instant changes. Animate transform and opacity only.
 */
export function MotionProvider({ children }: { children: React.ReactNode }) {
  return (
    <MotionConfig reducedMotion="user" transition={{ type: "spring", stiffness: 520, damping: 42, mass: 0.8 }}>
      <LazyMotion features={features} strict>
        {children}
      </LazyMotion>
    </MotionConfig>
  );
}
