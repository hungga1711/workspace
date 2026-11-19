import { PageSkeleton } from "@/components/ui/PageSkeleton";

/** A list page: the skeleton shows at once while the server renders it (no record here, so no 404 to protect). */
export default function Loading() {
  return <PageSkeleton />;
}
