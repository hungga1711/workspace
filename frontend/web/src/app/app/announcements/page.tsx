import type { Metadata } from "next";
import { gw } from "@/lib/gateway";
import { getT } from "@/lib/i18n/server";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { AnnouncementsFeed } from "@/components/announcements/AnnouncementsFeed";
import type { Announcement } from "@/components/announcements/types";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("shell.nav.announcements") };
}

/**
 * Company announcements for the reader (what targets them: everyone, or their department), unread first. Home stopped
 * showing them; a new one arrives as a notification that opens it here (`?open=<id>`).
 */
export default async function AnnouncementsPage({ searchParams }: { searchParams: Promise<{ open?: string }> }) {
  const { open } = await searchParams;
  const data = await gw<{ announcements: Announcement[]; unread: number; canPublish: boolean }>("/api/employee/announcements?limit=100").catch(() => null);
  if (!data) return <LoadFailed className="bg-surface shadow-card min-h-14 rounded-xl px-5 py-3.5" />;
  return <AnnouncementsFeed items={data.announcements} canPublish={data.canPublish} open={open ?? null} />;
}
