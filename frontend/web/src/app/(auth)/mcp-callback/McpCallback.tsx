"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import { useT } from "@/lib/i18n/client";

export function McpCallback({ code, state, error }: { code: string; state: string; error: string }) {
  const t = useT();
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(error ? { ok: false, text: error } : null);
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current || error) return;
    sent.current = true;
    const tell = (ok: boolean) => {
      try {
        window.opener?.postMessage({ type: "mcp-oauth", ok }, window.location.origin);
      } catch {}
    };
    if (!code || !state) {
      setResult({ ok: false, text: t("mcpClient.callback.missing") });
      tell(false);
      return;
    }
    api<{ server: string }>("ai/mcp/oauth/callback", { method: "POST", body: { code, state } })
      .then((r) => {
        setResult({ ok: true, text: t("mcpClient.callback.done", { server: r.server }) });
        tell(true);
        // A popup closes itself; a tab that came here without one keeps the link back.
        if (window.opener) setTimeout(() => window.close(), 1200);
      })
      .catch((e: { body?: { message?: string } }) => {
        setResult({ ok: false, text: e.body?.message ?? t("mcpClient.callback.failed") });
        tell(false);
      });
  }, [code, state, error, t]);
  return (
    <div className="grid gap-3 text-center" role="status">
      <h1 className="font-display m-0 text-xl font-semibold tracking-tight">{t("mcpClient.callback.title")}</h1>
      <p className={result ? (result.ok ? "text-ok m-0 text-sm" : "text-block m-0 text-sm [overflow-wrap:anywhere]") : "text-ink-2 m-0 text-sm"}>
        {result ? result.text : t("mcpClient.callback.working")}
      </p>
      {result ? (
        <Link href="/app/ai/ask" className="text-sm">
          {t("mcpClient.callback.back")}
        </Link>
      ) : null}
    </div>
  );
}
