export type MeTab = "profile" | "org" | "security" | "agents" | "notify" | "away" | "privacy" | "attendance" | "leave" | "team" | "ai" | "time";
/**
 * Two pages: Hồ sơ của tôi at /app/me (profile, organisation, my AI) and
 * Chấm công at /app/time (attendance, leave, my team today). The finer `?tab=` values open the page that holds them.
 */
export type MeGroup = "profile" | "time";
export const TIME_TABS: readonly MeTab[] = ["attendance", "leave", "team", "time"];
export const meGroup = (t: MeTab): MeGroup => (TIME_TABS.includes(t) ? "time" : "profile");
