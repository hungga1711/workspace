import { aiMonitoring } from "@/lib/ai";
import { progressAccess } from "@/lib/viewer";
import { AdoptionNav, type AdoptionView } from "@/components/ai-hub/AdoptionNav";

/**
 * Áp dụng AI: the ideas work for everyone from the work itself; usage, the weekly report and the prompt library need
 * staff AI use to be recorded (Admin › AI). The weekly report is for people who follow a team.
 */
export default async function AdoptionLayout({ children }: { children: React.ReactNode }) {
  const [monitoring, access] = await Promise.all([aiMonitoring(), progressAccess()]);
  const views: AdoptionView[] = monitoring ? (access === "team" ? ["ideas", "usage", "report", "library"] : ["ideas", "usage", "library"]) : ["ideas"];
  return (
    <>
      <AdoptionNav views={views} />
      {children}
    </>
  );
}
