import { gw } from "@/lib/gateway";
import { adminLoad, sectionGate } from "@/components/admin/guard";
import { IntegrationsAdmin, type ApiKey, type Webhook } from "@/components/admin/IntegrationsAdmin";
import { config } from "@/lib/config";

export default async function IntegrationsPage() {
  const gate = await sectionGate("/admin/workspace/integrations");
  if (gate) return gate;
  const r = await adminLoad(() =>
    Promise.all([
      gw<{ keys: ApiKey[]; grantable: string[] }>("/api/identity/api-keys"),
      // Webhooks are their own section (another module); a failed read shows a retry there, not an error page.
      gw<{ webhooks: Webhook[]; events: Record<string, string> }>("/api/platform/workspace/webhooks").catch(() => null),
    ]),
  );
  if ("denied" in r) return r.denied;
  const [keys, hooks] = r.data;
  return (
    <IntegrationsAdmin keys={keys.keys} grantable={keys.grantable} webhooks={hooks?.webhooks ?? null} events={hooks?.events ?? {}} apiBase={`${config.publicGatewayUrl}/api`} />
  );
}
