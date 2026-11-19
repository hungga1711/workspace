import type { Metadata } from "next";
import { gw } from "@/lib/gateway";
import { getT } from "@/lib/i18n/server";
import { aiStatus } from "@/lib/ai";
import { AiProgressView, type ProgressBrief } from "@/components/ai-hub/AiProgressView";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("aiHub.progress.title") };
}

/** AI › Tiến độ: a manager's team (or one's own work) with who needs attention, and the AI's reading on request. */
export default async function AiProgressPage() {
  const [data, ai] = await Promise.all([gw<ProgressBrief>("/api/ai/progress/brief").catch(() => null), aiStatus()]);
  // A failed read says so in its tile (with retry) instead of passing for "nobody needs attention".
  const empty: ProgressBrief = { scope: "self", people: 0, totals: {}, attention: [], highlights: [] };
  return <AiProgressView data={data ?? empty} aiEnabled={ai.assistant} failed={!data} />;
}
