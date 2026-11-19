import { cx } from "@/lib/ui";
import type { McpTone } from "@/lib/mcp-gallery";

const TONE: Record<McpTone, string> = {
  accent: "bg-accent-wash text-accent-text",
  ok: "bg-ok-wash text-ok",
  violet: "bg-violet-wash text-violet-text",
  tangerine: "bg-tangerine-wash text-tangerine-text",
  rose: "bg-rose-wash text-rose-text",
  sky: "bg-sky-wash text-sky-text",
  brand: "bg-brand-wash text-brand-text",
};

/** An MCP server's tile: its monogram on a soft wash (our colours, never the vendor's logo). */
export function McpMonogram({ mono, tone, size = "md" }: { mono: string; tone: McpTone; size?: "sm" | "md" }) {
  return (
    <span
      aria-hidden="true"
      className={cx("grid shrink-0 place-items-center font-semibold tracking-tight", size === "sm" ? "size-6 rounded-md text-[11px]" : "size-9 rounded-lg text-xs", TONE[tone])}
    >
      {mono}
    </span>
  );
}
