import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { gw, GatewayError } from "@/lib/gateway";
import { getT } from "@/lib/i18n/server";
import { AskConversation } from "@/components/chat/AskConversation";
import type { AskThread } from "@/components/workflows/types";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("workflows.ask.title") };
}

/**
 * The temporary conversation for an agent run's questions (docs/architecture/agent-questions.md): read from the run,
 * not from chat, so nothing is stored as a channel. A run the reader may not see answers 404, like a channel; any
 * other failed read still opens the screen with a retry.
 */
export default async function AskPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  let thread: AskThread | null = null;
  try {
    thread = await gw<AskThread>(`/api/work/runs/${encodeURIComponent(runId)}/questions`);
  } catch (e) {
    if (e instanceof GatewayError && e.status === 404) notFound();
  }
  return <AskConversation runId={runId} initial={thread} />;
}
