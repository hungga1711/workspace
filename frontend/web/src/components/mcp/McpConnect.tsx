"use client";

import { CopyButton } from "@/components/ui/CopyButton";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n/client";
import { btn, btnPrimary, btnSm, cx, mono } from "@/lib/ui";

type Client = "claude" | "claudeCode" | "chatgpt" | "cursor" | "vscode" | "other";
const CLIENTS: Client[] = ["claude", "claudeCode", "chatgpt", "cursor", "vscode", "other"];

/** The MCP address: this app's own origin (the proxy, or the app's rewrites, send /api/mcp to the server). */
export function useMcpUrl(): string {
  const [url, setUrl] = useState("/api/mcp");
  useEffect(() => setUrl(`${window.location.origin}/api/mcp`), []);
  return url;
}

/** One-click installs and config snippets per client (docs/integrations/mcp.md has the same). */
export function mcpSnippets(url: string) {
  const b64 = (s: string) => (typeof window === "undefined" ? "" : window.btoa(s));
  return {
    // Not "workspace": Claude Code keeps that name for itself and refuses to add a server under it.
    claudeCode: `claude mcp add --transport http workspace-app ${url}`,
    cursorLink: `cursor://anysphere.cursor-deeplink/mcp/install?name=workspace&config=${encodeURIComponent(b64(JSON.stringify({ url })))}`,
    cursorJson: JSON.stringify({ mcpServers: { workspace: { url } } }, null, 2),
    vscodeLink: `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: "workspace", type: "http", url }))}`,
    vscodeJson: JSON.stringify({ servers: { workspace: { type: "http", url } } }, null, 2),
    otherJson: JSON.stringify({ mcpServers: { workspace: { type: "http", url } } }, null, 2),
  };
}

function Code({ text }: { text: string }) {
  return <pre className={cx(mono, "bg-ground text-ink m-0 overflow-x-auto whitespace-pre rounded-md px-3 py-2.5 text-xs/5")}>{text}</pre>;
}

/**
 * "Kết nối AI agent": the MCP address with a copy button, then what to do in each AI app. With OAuth every app below
 * needs only the address; "Khác" also explains the personal-key route for apps without OAuth.
 */
export function McpConnect({ keysHref }: { keysHref?: string }) {
  const t = useT();
  const url = useMcpUrl();
  const [client, setClient] = useState<Client>("claude");
  const s = mcpSnippets(url);
  return (
    <div className="grid min-w-0 gap-4">
      <div className="grid gap-2">
        <p className="text-ink m-0 text-sm font-medium">{t("mcpServer.url.label")}</p>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <code className={cx(mono, "bg-ground text-ink min-w-0 flex-1 truncate rounded-md px-3 py-2 text-[13px]")} title={url}>
            {url}
          </code>
          <CopyButton text={url} />
        </div>
        <p className="text-ink-2 m-0 text-xs">{t("mcpServer.url.intro")}</p>
      </div>
      <div className="grid min-w-0 gap-3">
        {/* Chips that wrap rather than a sliding track: six app names do not fit one row at 390px. */}
        <div role="radiogroup" aria-label={t("mcpServer.clients.label")} className="flex flex-wrap gap-1.5">
          {CLIENTS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={client === c}
              onClick={() => setClient(c)}
              className={cx(
                "h-7 rounded-md px-2.5 text-[13px] transition-colors duration-100",
                client === c ? "bg-selected text-ink font-medium" : "text-ink-2 hover:bg-hover hover:text-ink shadow-[0_0_0_1px_var(--hairline)]",
              )}
            >
              {t(`mcpServer.clients.${c}`)}
            </button>
          ))}
        </div>
        <p className="text-ink-2 m-0 text-sm">{t(`mcpServer.steps.${client}`)}</p>
        {client === "claude" || client === "chatgpt" ? null : client === "claudeCode" ? (
          <>
            <Code text={s.claudeCode} />
            <div>
              <CopyButton text={s.claudeCode} label={t("mcpServer.url.copyCommand")} />
            </div>
          </>
        ) : client === "cursor" ? (
          <>
            <div className="flex flex-wrap gap-2">
              <a href={s.cursorLink} className={cx(btnPrimary, btnSm, "no-underline")}>
                {t("mcpServer.steps.addCursor")}
              </a>
              <CopyButton text={s.cursorJson} label={t("mcpServer.url.copyConfig")} />
            </div>
            <Code text={s.cursorJson} />
          </>
        ) : client === "vscode" ? (
          <>
            <div className="flex flex-wrap gap-2">
              <a href={s.vscodeLink} className={cx(btnPrimary, btnSm, "no-underline")}>
                {t("mcpServer.steps.addVscode")}
              </a>
              <CopyButton text={s.vscodeJson} label={t("mcpServer.url.copyConfig")} />
            </div>
            <Code text={s.vscodeJson} />
          </>
        ) : (
          <>
            <Code text={s.otherJson} />
            <div className="flex flex-wrap gap-2">
              <CopyButton text={s.otherJson} label={t("mcpServer.url.copyConfig")} />
              {keysHref ? (
                <Link href={keysHref} className={cx(btn, btnSm, "no-underline")}>
                  {t("mcpServer.steps.createKey")}
                </Link>
              ) : null}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
