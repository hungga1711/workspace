import { PageSkeleton } from "@/components/ui/PageSkeleton";

/** The conversation frame appears at once (sidebar and top bar stay), never a blank page, while the server picks the channel. */
export default function Loading() {
  return <PageSkeleton variant="conversation" />;
}
