"use client";

import { useT } from "@/lib/i18n/client";
import { MCP_GALLERY, type McpPreset } from "@/lib/mcp-gallery";
import { cx } from "@/lib/ui";
import { McpMonogram } from "@/components/ai/McpMonogram";
import { PlusIcon } from "@/components/app/icons";

const card = "rounded-xl shadow-card bg-surface";

/** The gallery: popular servers in one click, and any other by its URL. */
export function Gallery({ onPick }: { onPick: (preset: McpPreset | null) => void }) {
  const t = useT();
  return (
    <ul className="m-0 grid list-none grid-cols-2 gap-2.5 p-0 lg:grid-cols-3">
      {MCP_GALLERY.map((p) => (
        <li key={p.id}>
          <button type="button" onClick={() => onPick(p)} className={cx(card, "hover:bg-hover/60 flex h-full w-full min-w-0 items-start gap-3 p-3 text-left transition-colors")}>
            <McpMonogram mono={p.mono} tone={p.tone} />
            <span className="grid min-w-0 gap-0.5">
              <span className="text-ink text-sm font-semibold">{p.name}</span>
              {/* Phones: two narrow columns, the name and how it signs in. */}
              <span className="text-ink-2 text-xs max-sm:hidden">{t(`mcpClient.gallery.${p.id}`)}</span>
              <span className="text-ink-2 text-xs">{t(`mcpClient.authShort.${p.auth}`)}</span>
            </span>
          </button>
        </li>
      ))}
      <li>
        <button
          type="button"
          onClick={() => onPick(null)}
          className={cx(card, "hover:bg-hover/60 flex h-full w-full min-w-0 items-start gap-3 border-dashed p-3 text-left transition-colors")}
        >
          <span className="bg-hover text-ink-2 grid size-9 shrink-0 place-items-center rounded-lg">
            <PlusIcon className="size-4" />
          </span>
          <span className="grid min-w-0 gap-0.5">
            <span className="text-ink text-sm font-semibold">{t("mcpClient.custom")}</span>
            <span className="text-ink-2 text-xs max-sm:hidden">{t("mcpClient.customHint")}</span>
          </span>
        </button>
      </li>
    </ul>
  );
}
