import { PageSkeleton } from "@/components/ui/PageSkeleton";

/** Every admin page without its own skeleton: something shows at once instead of a blank page. */
export default function Loading() {
  return <PageSkeleton />;
}
