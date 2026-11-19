import { getT } from "@/lib/i18n/server";
import { gw } from "@/lib/gateway";
import { readPage } from "@/lib/page-read";
import { ReadFailed } from "@/components/ui/ReadFailed";
import { BoardLoader } from "@/components/work/BoardLoader";
import { ProjectHeader, type ProjectDetail } from "@/components/work/ProjectHeader";
import type { BoardData } from "@/components/work/Board";
import type { Project } from "@/components/work/types";
import type { Metadata } from "next";
import { refParam } from "@/components/work/loaders";
import { gwOnce } from "@/lib/gateway";
import { canManageTeams } from "@/lib/viewer";
import { ProjectTabs } from "@/components/work/ProjectTabs";
import { ProjectReviews } from "@/components/integrations/ProjectReviewsLazy";
// The Overview (charts, the status form) loads only when it is the open view, not with every board.
import { ProjectOverview } from "@/components/work/ProjectOverviewLazy";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const r = await gwOnce<BoardData>(`/api/work/projects/${refParam(id)}/board`).catch(() => null);
  return r ? { title: r.project.name } : {};
}

export default async function ProjectPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ view?: string }> }) {
  const tx = await getT();
  // The address may carry the project's code (`P-001`) or its id; everything below uses the id it resolves to.
  const ref = refParam((await params).id);
  // Overview (the boss's view: pace, attention, weekly status) or Board (the working view, the default).
  const view = (await searchParams).view;
  const overview = view === "overview";
  const reviews = view === "reviews";
  const r = await readPage(
    Promise.all([
      overview || reviews ? Promise.resolve(null) : gwOnce<BoardData>(`/api/work/projects/${ref}/board`),
      // Only for the counts and the move-to-project picker: without it the board still opens.
      gw<{ projects: Project[] }>("/api/work/projects").catch(() => ({ projects: [] as Project[] })),
      gw<ProjectDetail>(`/api/work/projects/${ref}`),
      // Whether a code host is connected (the integrations hub): only then is there a Reviews tab.
      gw<{ integrations: { category: string; connected: boolean }[] }>("/api/work/integrations").catch(() => null),
    ]),
  );
  if (!r.data) return <ReadFailed status={r.failed} />;
  const [board, projects, detail, hub] = r.data;
  const hasReviews = !!hub?.integrations.some((i) => i.category === "development" && i.connected);
  // The project list holds active projects only: an archived one's counts come from the archived list (its
  // board still shows its open cards, so "0 open tasks" would contradict the page).
  const p =
    projects.projects.find((x) => x.id === detail.id) ??
    (detail.status === "archived"
      ? (await gw<{ projects: Project[] }>("/api/work/projects?status=archived").catch(() => ({ projects: [] as Project[] }))).projects.find((x) => x.id === detail.id)
      : undefined);
  return (
    <>
      <ProjectHeader p={detail} openTasks={p?.openTasks ?? 0} overdueTasks={p?.overdueTasks ?? 0} canManageTeams={await canManageTeams()} />
      <ProjectTabs id={detail.code} current={reviews ? "reviews" : overview ? "overview" : "board"} reviews={hasReviews || reviews} />
      {reviews ? (
        <ProjectReviews projectId={detail.id} />
      ) : overview || !board ? (
        <ProjectOverview project={{ id: detail.id, name: detail.name, ownerId: detail.ownerId, dueAt: detail.dueAt, createdAt: p?.createdAt ?? null, people: p?.people ?? [] }} />
      ) : (
        <BoardLoader initial={board} projects={projects.projects} />
      )}
      <p className="sr-only">{tx("work.projectsIdPage.ban_phim_tab_toi")}</p>
    </>
  );
}
