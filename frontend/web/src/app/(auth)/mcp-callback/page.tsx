import type { Metadata } from "next";
import { getT } from "@/lib/i18n/server";
import { authCard, cx } from "@/lib/ui";
import { McpCallback } from "./McpCallback";

export async function generateMetadata(): Promise<Metadata> {
  const tx = await getT();
  return { title: tx("mcpClient.callback.title"), robots: { index: false } };
}

/**
 * Where an outside MCP server's sign-in sends the browser back (the redirect URI workspace registers with it). The
 * code is handed to the server from the browser (same session and CSRF check as any request), then the popup tells
 * the page that opened it and closes.
 */
export default async function McpCallbackPage({ searchParams }: { searchParams: Promise<{ code?: string; state?: string; error?: string; error_description?: string }> }) {
  const sp = await searchParams;
  return (
    <div className={cx(authCard, "!shadow-hero")}>
      <McpCallback code={sp.code ?? ""} state={sp.state ?? ""} error={sp.error ? (sp.error_description ?? sp.error).slice(0, 200) : ""} />
    </div>
  );
}
