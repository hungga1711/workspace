import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getT } from "@/lib/i18n/server";
import { gw, GatewayError } from "@/lib/gateway";
import { freshSession } from "@/lib/session";
import { authCard, cx } from "@/lib/ui";
import { permLabel } from "@/components/mcp/labels";
import { ConsentForm } from "./ConsentForm";

export async function generateMetadata(): Promise<Metadata> {
  const tx = await getT();
  return { title: tx("mcpServer.consent.pageTitle"), robots: { index: false } };
}

interface ClientInfo {
  client: { id: string; name: string; clientUri: string | null; redirectHost: string };
  grantable: string[];
  presets: { read: string[]; write: string[] };
  mcp: { read: string[]; write: string[] };
  connectedBefore: string[] | null;
}

type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

/**
 * OAuth consent (MCP clients: Claude, ChatGPT, Cursor, VS Code). The client sent the person here with its
 * authorization request; they sign in if needed, see which app asks and where they will be sent back, pick what it
 * may do, and allow or deny. Nothing redirects to an address the client did not register (identity checks it).
 */
export default async function Authorize({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const tx = await getT();
  const q = new URLSearchParams(Object.entries(sp).flatMap(([k, v]) => (typeof v === "string" ? [[k, v]] : [])));
  const session = await freshSession();
  if (!session) redirect(`/login?next=${encodeURIComponent(`/oauth/authorize?${q.toString()}`)}`);

  const clientId = one(sp.client_id);
  const redirectUri = one(sp.redirect_uri);
  const invalid = (
    <div className={cx(authCard, "!shadow-hero")}>
      <h1 className="font-display m-0 mb-2 text-lg font-semibold tracking-tight">{tx("mcpServer.consent.invalidTitle")}</h1>
      <p className="text-ink-2 m-0 text-sm">{tx("mcpServer.consent.invalidBody")}</p>
    </div>
  );
  if (!clientId || !redirectUri) return invalid;
  let info: ClientInfo;
  try {
    info = await gw<ClientInfo>(`/api/identity/oauth/clients/${encodeURIComponent(clientId)}?redirect_uri=${encodeURIComponent(redirectUri)}`);
  } catch (e) {
    // Unknown app or a redirect address it never registered: say so here, never send the browser anywhere.
    if (e instanceof GatewayError && (e.status === 404 || e.status === 400)) return invalid;
    throw e;
  }
  // From here the redirect address is the client's own, so protocol errors go back to it (RFC 6749 §4.1.2.1).
  const state = one(sp.state);
  const back = (error: string, description: string) => {
    const u = new URL(redirectUri);
    u.searchParams.set("error", error);
    u.searchParams.set("error_description", description);
    if (state) u.searchParams.set("state", state);
    redirect(u.toString());
  };
  if (one(sp.response_type) !== "code") back("unsupported_response_type", "only response_type=code is supported");
  const challenge = one(sp.code_challenge);
  if (!challenge || !/^[A-Za-z0-9_-]{43}$/.test(challenge) || one(sp.code_challenge_method) !== "S256") back("invalid_request", "PKCE with code_challenge_method=S256 is required");

  const offered = info.grantable.filter((p) => info.mcp.read.includes(p) || info.mcp.write.includes(p));
  const wantsWrite = !one(sp.scope) || /\bmcp:write\b/.test(one(sp.scope) ?? "");
  return (
    <ConsentForm
      request={{ clientId, redirectUri, codeChallenge: challenge!, state, resource: one(sp.resource) }}
      client={info.client}
      who={session!.name || session!.email}
      perms={offered.map((p) => ({ id: p, label: permLabel(tx, p), write: info.mcp.write.includes(p) }))}
      presets={info.presets}
      initialPreset={info.presets.write.some((p) => info.mcp.write.includes(p)) && wantsWrite ? "write" : "read"}
      reconnect={info.connectedBefore !== null}
    />
  );
}
