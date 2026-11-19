import { gw } from "@/lib/gateway";
import { adminLoad, sectionGate } from "@/components/admin/guard";
import { AnnouncementsAdmin } from "@/components/admin/AnnouncementsAdmin";
import type { Announcement } from "@/components/announcements/types";

export default async function AnnouncementsPage() {
  const gate = await sectionGate("/admin/workspace/announcements");
  if (gate) return gate;
  const r = await adminLoad(() =>
    Promise.all([
      gw<{ announcements: Announcement[]; canPublish: boolean }>("/api/employee/announcements?all=1&limit=100"),
      gw<{ departments: { id: string; name: string }[] }>("/api/employee/departments").catch(() => ({ departments: [] })),
    ]),
  );
  if ("denied" in r) return r.denied;
  const [a, d] = r.data;
  return <AnnouncementsAdmin announcements={a.announcements} canPublish={a.canPublish} departments={d.departments} />;
}
