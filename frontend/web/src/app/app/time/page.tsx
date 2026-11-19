import { requireFeature } from "@/lib/features";
import type { Metadata } from "next";
import { getT } from "@/lib/i18n/server";
import { TIME_TABS, type MeTab } from "@/components/me/groups";
import { renderMe } from "@/components/me/renderMe";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("shell.nav.time") };
}

/** Chấm công: today's clock-in, the attendance history, leave and holidays, and the leave a manager has to approve. */
export default async function TimePage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const sp = await searchParams;
  await requireFeature("time");
  return renderMe((TIME_TABS.includes(sp.tab as MeTab) ? sp.tab : "time") as MeTab);
}
