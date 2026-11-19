import type { McpTone } from "@/lib/mcp-gallery";

/** The integrations hub as the server describes it (backend work/integrations/hub.ts, define.ts). */
export interface HubIntegration {
  id: string;
  name: string;
  category: "development" | "design" | "other";
  summary: string;
  site: string;
  selfHosted: boolean;
  scansRepos: boolean;
  tokenHelp: { url: string; needs: string };
  connected: boolean;
}
export interface HubConnection {
  id: string;
  provider: string;
  site: string;
  selfHosted: boolean;
  privateNetwork: boolean;
  account: string;
  repos: string[];
  enabled: boolean;
  lastOkAt: string | null;
  lastError: string | null;
  createdAt: string;
  links: number;
}
export type CardState = "open" | "draft" | "merged" | "closed" | "done" | "none";
export interface WorkCardData {
  kind: "review" | "issue" | "design" | "generic";
  title: string;
  ref: string;
  state: CardState;
  author?: string;
  updatedAt?: string;
  labels?: string[];
  branch?: string;
  target?: string;
  additions?: number;
  deletions?: number;
  comments?: number;
  checks?: "passing" | "failing" | "pending";
  reviewers?: { name: string; state: "approved" | "changes" | "pending" }[];
  embedUrl?: string;
}
export interface WorkLink {
  id: string;
  taskId: string;
  provider: string;
  providerName: string;
  url: string;
  kind: WorkCardData["kind"];
  source: "manual" | "found" | "scan";
  card: WorkCardData | null;
  cardAt: string | null;
  error: string | null;
  hasThumbnail: boolean;
  /** false: the company has not connected this tool, so its state cannot be read. */
  connected: boolean;
}

/**
 * An integration's tile: a monogram on a soft wash in our own colours, never the vendor's logo (as the MCP gallery
 * does). One not listed here (a new provider nobody gave a tile yet) gets its first letters and a colour by its id.
 */
const TILES: Record<string, { mono: string; tone: McpTone }> = {
  github: { mono: "GH", tone: "violet" },
  gitlab: { mono: "GL", tone: "tangerine" },
  figma: { mono: "Fg", tone: "rose" },
};
const TONES: McpTone[] = ["accent", "ok", "violet", "tangerine", "rose", "sky"];
export function tileOf(id: string, name: string): { mono: string; tone: McpTone } {
  const known = TILES[id];
  if (known) return known;
  const sum = [...id].reduce((n, ch) => n + ch.charCodeAt(0), 0);
  return { mono: name.replace(/[^A-Za-z0-9]/g, "").slice(0, 2) || "?", tone: TONES[sum % TONES.length]! };
}
