/**
 * Which modules are asked for the admin overview's "Needs you" list, from what the viewer may fix (null permissions =
 * unknown: ask them all; each module checks again and answers only the kinds this person can act on). Shared by the
 * overview (server) and the count on the admin menu (client).
 */
export type AttentionSourceKey = "ai" | "work" | "platform" | "identity";

export function attentionSources(perms: ReadonlySet<string> | null, features: Record<string, boolean> | null | undefined): AttentionSourceKey[] {
  const may = (...p: string[]) => !perms || p.some((x) => perms.has(x));
  const ai = features?.ai !== false;
  return [
    ...(ai && may("ai.agent.manage", "ai.policy.manage") ? (["ai"] as const) : []),
    // Agent runs for who manages agents; task sync for who configures the workspace.
    ...(may("workspace.configure") || (ai && may("ai.agent.manage")) ? (["work"] as const) : []),
    ...(may("workspace.configure") ? (["platform", "identity"] as const) : []),
  ];
}
