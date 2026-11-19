import { gw } from "@/lib/gateway";
import { readPage } from "@/lib/page-read";
import { ReadFailed } from "@/components/ui/ReadFailed";
import type { ChannelSummary } from "@/components/shell/types";
import { ChannelBrowser, type BrowseChannel } from "@/components/chat/ChannelBrowser";
import type { Metadata } from "next";
import { getT } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("chat.browser.title") };
}

export default async function BrowsePage() {
  const read = await readPage(gw<{ channels: ChannelSummary[]; browsable: BrowseChannel[]; archived?: BrowseChannel[] }>("/api/chat/channels"));
  if (!read.data) return <ReadFailed status={read.failed} />;
  const r = read.data;
  return <ChannelBrowser joined={r.channels.filter((c) => c.kind === "public" || c.kind === "private")} browsable={r.browsable} archived={r.archived ?? []} />;
}
