import { requireFeature } from "@/lib/features";
import { redirect } from "next/navigation";

/** Moved to AI › Áp dụng AI › Báo cáo tuần; old links and report emails land there. */
export default async function OldAiReport({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const { days } = await searchParams;
  await requireFeature("ai");
  redirect(`/app/ai/adoption/report${days ? `?days=${encodeURIComponent(days)}` : ""}`);
}
