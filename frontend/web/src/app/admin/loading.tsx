import { PageSkeleton } from "@/components/ui/PageSkeleton";

/**
 * Quản trị's content while a section renders on the server (the frame stays put). The frame itself has its own
 * skeleton in the layout (it loads members and the workspace first), so entering Quản trị never shows a blank page.
 */
export default function Loading() {
  return <PageSkeleton />;
}
