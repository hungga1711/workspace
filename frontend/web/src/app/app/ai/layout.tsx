import { requireFeature } from "@/lib/features";
import { AiFrame, type AiSection } from "@/components/ai-hub/AiFrame";

/**
 * AI, its own destination: Tiến độ (AI follows everyone's progress), Hỏi đáp (ask anything in the workspace), Áp dụng
 * AI (where AI could help with the work people do, and how they use it now) and Workflow (tasks handed to agents).
 * Every section works without a model: Tiến độ and Áp dụng AI are rules over the work and the recorded AI use, Hỏi đáp
 * still turns requests into tasks, and a workflow can run on the assignee's own computer.
 */
export default async function AiLayout({ children }: { children: React.ReactNode }) {
  // Left out at deploy time (DISABLED_FEATURES=ai): the destination and every page under it do not exist.
  await requireFeature("ai");
  // Connect: the AI on a person's own computer, for workflows, answers, token counts and the safety net.
  const sections: AiSection[] = ["progress", "ask", "adoption", "workflows", "connect"];
  return <AiFrame sections={sections}>{children}</AiFrame>;
}
