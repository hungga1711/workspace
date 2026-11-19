import { gw } from "@/lib/gateway";
import { readPage } from "@/lib/page-read";
import { ReadFailed } from "@/components/ui/ReadFailed";
import { ThreadsList, type ThreadItem } from "@/components/chat/SavedList";
import type { Metadata } from "next";
import { getT } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("chat.lists.threadsTitle") };
}

export default async function ThreadsPage() {
  const r = await readPage(gw<{ threads: ThreadItem[] }>("/api/chat/threads"));
  if (!r.data) return <ReadFailed status={r.failed} />;
  const { threads } = r.data;
  return <ThreadsList threads={threads} />;
}
