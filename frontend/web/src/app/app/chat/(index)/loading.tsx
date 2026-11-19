import { PageSkeleton } from "@/components/ui/PageSkeleton";

/**
 * The conversation frame appears at once (sidebar and top bar stay), never a blank page, while the server picks the
 * channel. It lives in the (index) group so it does not wrap /app/chat/[channelId]: a loading boundary there would
 * stream a 200 before notFound() runs, and another company's channel id must answer 404.
 */
export default function Loading() {
  return <PageSkeleton variant="conversation" />;
}
