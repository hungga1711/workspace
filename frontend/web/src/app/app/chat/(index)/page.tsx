import { gw } from "@/lib/gateway";
import type { ChannelSummary } from "@/components/shell/types";
import { ChatIndex } from "@/components/chat/ChatIndex";
import { getT } from "@/lib/i18n/server";

export async function generateMetadata() {
  return { title: (await getT())("shell.nav.inbox") };
}

/** Hộp thư: the inbox overview, the same on phones and desktop. */
export default async function ChatIndexPage() {
  const { channels, browsable, archived } = await gw<{
    channels: ChannelSummary[];
    browsable: { id: string; name: string; displayName?: string | null; topic: string }[];
    archived?: { id: string; name: string; displayName?: string | null; topic: string }[];
  }>("/api/chat/channels");
  return <ChatIndex channels={channels} browsable={browsable} archived={archived ?? []} />;
}
