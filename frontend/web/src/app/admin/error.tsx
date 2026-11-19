"use client";

import { ErrorScreen } from "@/components/ui/ErrorScreen";

export default function SegmentError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <ErrorScreen error={error} reset={reset} home="/admin/workspace" />;
}
