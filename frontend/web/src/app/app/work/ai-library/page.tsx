import { requireFeature } from "@/lib/features";
import { redirect } from "next/navigation";

/** Moved to AI › Áp dụng AI › Thư viện prompt. */
export default async function OldAiLibrary() {
  await requireFeature("ai");
  redirect("/app/ai/adoption/library");
}
