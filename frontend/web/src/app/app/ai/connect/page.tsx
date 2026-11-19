import type { Metadata } from "next";
import { gw } from "@/lib/gateway";
import { getT } from "@/lib/i18n/server";
import { aiStatus } from "@/lib/ai";
import { config } from "@/lib/config";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { ConnectView, type ConnectData } from "@/components/ai-hub/ConnectView";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("aiConnect.title") };
}

/**
 * AI › Connect: a person connects the AI on their own computer once, for workflows, answers, token counts and the
 * safety net (the ai module's local-connect.ts). Works with no company AI at all: three of the four need none.
 */
export default async function AiConnectPage() {
  const [data, ai] = await Promise.all([gw<ConnectData>("/api/ai/local/connect").catch(() => null), aiStatus()]);
  if (!data) return <LoadFailed className="bg-surface shadow-card rounded-xl px-5 py-4" />;
  return <ConnectView initial={data} origin={config.appUrl.replace(/\/$/, "")} providers={ai.assistant ? ai.providers.filter((p) => p !== "local") : []} />;
}
