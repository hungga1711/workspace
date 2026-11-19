"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/client";
import { useT } from "@/lib/i18n/client";
import { finishInPopup, openBlank } from "@/lib/mcp-oauth";
import type { WelcomeServer } from "./AskWelcome";
import { McpMonogram } from "./McpMonogram";

/** "AI dùng được": the outside tools connected for this person, and "Kết nối" where they sign in with their own account. */
export function ToolServers({ servers }: { servers: WelcomeServer[] }) {
  const t = useT();
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const connect = async (id: string) => {
    setBusy(id);
    setFailed(false);
    const win = openBlank();
    try {
      const r = await api<{ url: string }>(`ai/mcp/servers/${id}/connect`, { method: "POST" });
      await finishInPopup(win, r.url);
      router.refresh();
    } catch {
      win?.close();
      setFailed(true);
    } finally {
      setBusy(null);
    }
  };
  return (
    <section aria-labelledby="ask-tools" className="grid gap-2">
      <h2 id="ask-tools" className="text-ink-2 m-0 text-xs font-medium">
        {t("mcpClient.welcome.title")}
      </h2>
      <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
        {servers.map((s) => (
          <li key={s.id} className="bg-surface shadow-card flex min-w-0 items-center gap-2 rounded-full py-1 pl-1 pr-3 text-sm">
            <McpMonogram mono={s.mono} tone={s.tone} size="sm" />
            <span className="text-ink truncate">{s.name}</span>
            {s.connected ? null : (
              <button
                type="button"
                disabled={busy === s.id}
                onClick={() => void connect(s.id)}
                className="text-accent-text text-xs font-medium hover:underline disabled:opacity-50"
              >
                {t("mcpClient.welcome.connect")}
              </button>
            )}
          </li>
        ))}
      </ul>
      {failed ? (
        <p role="alert" className="text-block m-0 text-xs">
          {t("mcpClient.failed")}
        </p>
      ) : null}
    </section>
  );
}
