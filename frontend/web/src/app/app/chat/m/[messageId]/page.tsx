import { notFound, redirect, unstable_rethrow } from "next/navigation";
import { ReadFailed } from "@/components/ui/ReadFailed";
import { gw, GatewayError } from "@/lib/gateway";

/**
 * Permalink for one message, used by AI source links ("nguồn"): opens its channel with the message
 * in the log around it (and its thread in the side panel). The chat module checks the viewer may read it.
 */
export default async function MessageLink({ params }: { params: Promise<{ messageId: string }> }) {
  const { messageId } = await params;
  let root: { channelId: string; threadRootId: string | null };
  try {
    ({ root } = await gw<{ root: { channelId: string; threadRootId: string | null } }>(`/api/chat/messages/${encodeURIComponent(messageId)}/thread`));
  } catch (e) {
    unstable_rethrow(e);
    if (e instanceof GatewayError && e.status === 404) notFound();
    return <ReadFailed status={e instanceof GatewayError ? e.status : 500} />;
  }
  redirect(`/app/chat/${root.channelId}?m=${messageId}`);
}
