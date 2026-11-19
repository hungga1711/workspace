import { gw } from "@/lib/gateway";
import { readPage } from "@/lib/page-read";
import { ReadFailed } from "@/components/ui/ReadFailed";
import type { Message } from "@/components/chat/Conversation";
import { SavedList } from "@/components/chat/SavedList";
import type { Metadata } from "next";
import { getT } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("chat.lists.savedTitle") };
}

export default async function SavedPage() {
  const r = await readPage(gw<{ messages: Message[] }>("/api/chat/saved"));
  if (!r.data) return <ReadFailed status={r.failed} />;
  const { messages } = r.data;
  return <SavedList messages={messages} />;
}
