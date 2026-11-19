/**
 * Where a destination's link goes: AI and Work open their first section directly. /app/ai and /app/work are server
 * redirects, so linking to them cost one more round trip on every click.
 */
const DIRECT: Record<string, string> = { "/app/ai": "/app/ai/progress", "/app/work": "/app/work/tasks" };
export const navTarget = (href: string) => DIRECT[href] ?? href;
