import { gw } from "@/lib/gateway";
import { PeopleDirectory } from "@/components/me/PeopleDirectory";
import type { Metadata } from "next";
import { getT } from "@/lib/i18n/server";
import { readSession } from "@/lib/session";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("me.peopledirectory.danh_ba_cong_ty") };
}

export interface Employee {
  userId: string;
  code: string;
  displayName: string;
  title: string;
  department: string | null;
  managerId: string | null;
}

/** Organization: company directory with public fields only. */
export default async function PeoplePage({ searchParams }: { searchParams: Promise<{ u?: string; dept?: string }> }) {
  const { u, dept = "" } = await searchParams;
  // The first 60 by name (the directory searches on the server and pages with the cursor from there); with ?dept=
  // the whole company is read once and narrowed to that department, so no one past the first page goes missing.
  const [list, { departments }] = await Promise.all([
    gw<{ employees: Employee[]; nextCursor: string | null }>(dept ? "/api/employee/employees?all=1" : "/api/employee/employees?limit=60"),
    gw<{ departments: { name: string; members: number }[] }>("/api/employee/departments").catch(() => ({ departments: [] })),
  ]);
  const employees = dept ? list.employees.filter((e) => e.department === dept) : list.employees;
  const nextCursor = dept ? null : list.nextCursor;
  // Only a one-person directory offers the invite link, so only then ask who may invite.
  let canInvite = false;
  if (!dept && employees.length === 1 && !nextCursor) {
    const [session, { members }] = await Promise.all([
      readSession(),
      gw<{ members: { userId: string; isOwner: boolean; roles?: string[] }[] }>("/api/identity/members").catch(() => ({ members: [] })),
    ]);
    const me = members.find((m) => m.userId === session?.userId);
    canInvite = Boolean(me?.isOwner || me?.roles?.some((r) => r === "Owner" || r === "Admin"));
  }
  return (
    <PeopleDirectory
      employees={employees}
      nextCursor={nextCursor}
      focus={u}
      canInvite={canInvite}
      departments={departments.filter((d) => d.members > 0).map((d) => d.name)}
      dept={dept}
    />
  );
}
