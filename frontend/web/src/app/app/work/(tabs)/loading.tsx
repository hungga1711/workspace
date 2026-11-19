import { PageSkeleton } from "@/components/ui/PageSkeleton";

/**
 * Only on list pages: a loading boundary above a record page would turn its 404 into a 200.
 * The Work title and tabs live in the layout, so only the content below them shows this.
 */
export default function Loading() {
  return <PageSkeleton variant="content" />;
}
