/**
 * Admin › Kết nối AI › Máy chủ MCP: well-known remote MCP servers an admin adds in one click. Each entry is only a
 * starting point (name, address, how it signs in); the admin can change any of it, and "Máy chủ khác" takes any URL.
 * Logos are monogram tiles in our own colours, never the vendors' marks. Descriptions: mcpClient.gallery.<id>.
 */
export type McpTone = "accent" | "ok" | "violet" | "tangerine" | "rose" | "sky" | "brand";
export type McpAuth = "none" | "header" | "oauth";

export type McpPresetId = "github" | "linear" | "notion" | "sentry" | "stripe" | "supabase" | "vercel" | "intercom" | "huggingface" | "context7" | "cloudflare";

export interface McpPreset {
  id: McpPresetId;
  name: string;
  url: string;
  auth: McpAuth;
  /** Header for a token (auth "header"); Authorization (Bearer) when absent. */
  headerName?: string;
  /** Each person connects their own account (OAuth), rather than one company account. */
  perUser?: boolean;
  mono: string;
  tone: McpTone;
  /** Where the vendor documents its server (tokens, scopes). */
  docs: string;
}

export const MCP_GALLERY: McpPreset[] = [
  { id: "github", name: "GitHub", url: "https://api.githubcopilot.com/mcp/", auth: "header", mono: "GH", tone: "violet", docs: "https://github.com/github/github-mcp-server" },
  { id: "linear", name: "Linear", url: "https://mcp.linear.app/mcp", auth: "oauth", perUser: true, mono: "Li", tone: "sky", docs: "https://linear.app/docs/mcp" },
  { id: "notion", name: "Notion", url: "https://mcp.notion.com/mcp", auth: "oauth", perUser: true, mono: "N", tone: "brand", docs: "https://developers.notion.com/docs/mcp" },
  { id: "sentry", name: "Sentry", url: "https://mcp.sentry.dev/mcp", auth: "oauth", mono: "Se", tone: "rose", docs: "https://docs.sentry.io/product/sentry-mcp/" },
  { id: "stripe", name: "Stripe", url: "https://mcp.stripe.com", auth: "header", mono: "St", tone: "violet", docs: "https://docs.stripe.com/mcp" },
  { id: "supabase", name: "Supabase", url: "https://mcp.supabase.com/mcp", auth: "oauth", mono: "Sb", tone: "ok", docs: "https://supabase.com/docs/guides/getting-started/mcp" },
  { id: "vercel", name: "Vercel", url: "https://mcp.vercel.com", auth: "oauth", mono: "V", tone: "accent", docs: "https://vercel.com/docs/mcp/vercel-mcp" },
  {
    id: "intercom",
    name: "Intercom",
    url: "https://mcp.intercom.com/mcp",
    auth: "oauth",
    perUser: true,
    mono: "In",
    tone: "sky",
    docs: "https://developers.intercom.com/docs/guides/mcp",
  },
  { id: "huggingface", name: "Hugging Face", url: "https://huggingface.co/mcp", auth: "none", mono: "HF", tone: "tangerine", docs: "https://huggingface.co/settings/mcp" },
  { id: "context7", name: "Context7", url: "https://mcp.context7.com/mcp", auth: "none", mono: "C7", tone: "ok", docs: "https://github.com/upstash/context7" },
  {
    id: "cloudflare",
    name: "Cloudflare Docs",
    url: "https://docs.mcp.cloudflare.com/mcp",
    auth: "none",
    mono: "CF",
    tone: "tangerine",
    docs: "https://developers.cloudflare.com/agents/model-context-protocol/",
  },
];

export const presetOf = (id: string | null | undefined) => (id ? MCP_GALLERY.find((p) => p.id === id) : undefined);

const TONES: McpTone[] = ["accent", "ok", "violet", "tangerine", "rose", "sky"];

/** A server's tile: the preset's, else two letters of its name in a colour picked from the name. */
export function monogramOf(name: string, preset?: string | null): { mono: string; tone: McpTone } {
  const p = presetOf(preset);
  if (p) return { mono: p.mono, tone: p.tone };
  const words = name.trim().split(/\s+/).filter(Boolean);
  const mono = (words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : (words[0] ?? "?").slice(0, 2)).toUpperCase();
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return { mono, tone: TONES[h % TONES.length]! };
}
