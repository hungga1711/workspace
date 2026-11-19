import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { gw } from "@/lib/gateway";
import { getT } from "@/lib/i18n/server";
import { readPage } from "@/lib/page-read";
import { aiMonitoring } from "@/lib/ai";
import { ReadFailed } from "@/components/ui/ReadFailed";
import { PersonView, type PersonAccess } from "@/components/work/PersonView";
import type { TeamPerson } from "@/components/work/team-types";
import type { AiConversation } from "@/components/work/AiOversightView";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("person.title") };
}

interface PersonRead {
  access: PersonAccess;
  profile: { userId: string; displayName: string; title: string | null; department: string | null; departmentId: string | null };
  person: TeamPerson | null;
}

/**
 * One person in Work: what they work on and how it is going. The work module decides who may open it (yourself, your
 * reporting line, everyone for company followers, same-department colleagues as numbers only); anyone else sees
 * "no access", not a 404. AI use is asked separately and only shown when the ai module lets the caller read it.
 */
export default async function PersonPage({ params }: { params: Promise<{ userId: string }> }) {
  const { userId } = await params;
  if (!/^[0-9A-Za-z_-]{6,64}$/.test(userId)) notFound();
  const r = await readPage(gw<PersonRead>(`/api/work/people/${userId}`));
  if (r.failed !== undefined) return <ReadFailed status={r.failed} />;
  const { access, profile, person } = r.data;
  // Colleagues get work numbers only; the AI section is for oneself and the people one manages.
  const ai =
    access !== "colleague" && (await aiMonitoring()) ? await gw<{ conversations: AiConversation[] }>(`/api/ai/oversight/people/${userId}?days=30`).catch(() => null) : null;
  return <PersonView userId={userId} access={access} profile={profile} person={person} ai={ai} />;
}
