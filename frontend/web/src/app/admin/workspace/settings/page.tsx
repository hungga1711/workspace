import { gw } from "@/lib/gateway";
import { adminLoad, sectionGate } from "@/components/admin/guard";
import { SettingsAdmin, type WsConfig } from "@/components/admin/SettingsAdmin";

export default async function SettingsPage() {
  const gate = await sectionGate("/admin/workspace/settings");
  if (gate) return gate;
  const r = await adminLoad(() => gw<{ configVersion: number; config: WsConfig }>("/api/platform/workspace"));
  if ("denied" in r) return r.denied;
  return <SettingsAdmin version={r.data.configVersion} config={r.data.config} />;
}
