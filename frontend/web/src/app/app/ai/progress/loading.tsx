import { PageSkeleton } from "@/components/ui/PageSkeleton";

/**
 * AI's landing section: its frame shows at once on click (the AI section tabs stay), while the server reads the team's
 * brief. Tiến độ never answers 404, so a loading boundary here cannot hide one.
 */
export default function Loading() {
  return <PageSkeleton variant="content" />;
}
