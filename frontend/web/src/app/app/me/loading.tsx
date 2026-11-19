import { PageSkeleton } from "@/components/ui/PageSkeleton";

/** Only on list pages: a loading boundary above a record page would turn its 404 into a 200. */
export default function Loading() {
  return <PageSkeleton />;
}
