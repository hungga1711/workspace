import { TIME_TABS, type MeTab } from "@/components/me/groups";
import { renderMe } from "@/components/me/renderMe";
import type { Metadata } from "next";
import { getT } from "@/lib/i18n/server";
import { redirect } from "next/navigation";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("shell.nav.me") };
}

export interface MeData {
  profile: { userId: string; code: string; displayName: string; title: string; departmentId: string | null; managerId: string | null; phone: string; location: string } | null;
  attendanceToday: { checkIn: string; checkOut: string | null } | null;
  leaveBalances: { type: string; entitled: number; used: number; pending: number }[];
}
export interface LeaveRequest {
  id: string;
  userId: string;
  type: string;
  startDate: string;
  endDate: string;
  days: number;
  status: string;
  reason: string;
  createdAt: string;
}

const TABS: MeTab[] = ["profile", "org", "security", "agents", "notify", "away", "privacy", "attendance", "leave", "team", "ai", "time"];

/** Hồ sơ của tôi; old Chấm công links (`?tab=leave`, …, in notifications too) move to /app/time. */
export default async function MePage({ searchParams }: { searchParams: Promise<{ tab?: string; new?: string }> }) {
  const sp = await searchParams;
  if (TIME_TABS.includes(sp.tab as MeTab)) redirect(`/app/time?tab=${sp.tab}${sp.new ? `&new=${sp.new}` : ""}`);
  return renderMe((TABS.includes(sp.tab as MeTab) ? sp.tab : "profile") as MeTab);
}
