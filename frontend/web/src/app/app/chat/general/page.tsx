import { redirect } from "next/navigation";
import { gw } from "@/lib/gateway";
import { GeneralPending } from "@/components/onboarding/GeneralPending";

/**
 * Onboarding step 4 entry. #general is created asynchronously from the
 * workspace.created event, so a brand-new workspace may need a second.
 */
export default async function GeneralChannel() {
  const { channels } = await gw<{ channels: { id: string; name: string | null }[] }>("/api/chat/channels");
  const general = channels.find((c) => c.name === "general");
  if (general) redirect(`/app/chat/${general.id}`);
  return <GeneralPending />;
}
