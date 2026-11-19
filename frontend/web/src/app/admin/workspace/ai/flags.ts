import { gw, GatewayError } from "@/lib/gateway";

export interface AiWorkspace {
  configVersion: number;
  config: Record<string, unknown> & { features?: { ai?: { assistant?: boolean; monitoring?: boolean } }; branding?: { displayName?: string } };
  workspace?: { name?: string };
}

/**
 * The AI switches every Admin › AI tab starts from. A throttled (429) or failing read returns null so only the page's
 * sections say so (with a retry); a refusal (403) or a missing record still takes the guard's way.
 */
export async function aiWorkspace() {
  const ws = await gw<AiWorkspace>("/api/platform/workspace").catch((e: unknown) => {
    if (e instanceof GatewayError && (e.status === 403 || e.status === 404)) throw e;
    return null;
  });
  if (!ws) return null;
  return { ws, assistant: ws.config.features?.ai?.assistant === true, monitoring: ws.config.features?.ai?.monitoring === true };
}
