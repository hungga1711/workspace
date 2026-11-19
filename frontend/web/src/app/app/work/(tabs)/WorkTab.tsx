import Link from "next/link";
import { getLocale, getT } from "@/lib/i18n/server";
import { getTimeZone } from "@/lib/setup";
import { defaultCurrency } from "@/components/work/defaultCurrency";
import { gw, GatewayError } from "@/lib/gateway";
import { ReadFailed } from "@/components/ui/ReadFailed";
import {
  BoardLoader,
  CalendarView,
  DocsHome,
  DriveView,
  GanttView,
  GoalsView,
  MeetingsView,
  OpsView,
  ProjectList,
  ScopeCrumb,
  TaskList,
  WhiteboardList,
} from "@/components/work/tabs";
import type { WbFolders, WhiteboardSummary } from "@/components/whiteboard/types";
import type { GanttData } from "@/components/work/GanttView";
import { cookies } from "next/headers";
import { requireFeature } from "@/lib/features";
import { notFound, unstable_rethrow } from "next/navigation";
import { BoardIcon, GanttIcon, ListIcon } from "@/components/app/icons";
import type { DocsHomeData, PageRow } from "@/components/docs/DocsHome";
import type { DriveData } from "@/components/drive/DriveView";
import type { Scope } from "@/components/work/ScopeCrumb";
import { TasksNav } from "@/components/work/WorkTabs";
import { IconSwitch } from "@/components/ui/Toolbar";
import type { BoardData } from "@/components/work/Board";
import type { MeetingFollowups, MeetingRow } from "@/components/work/MeetingsView";
import type { WorkTabKey } from "@/components/work/workTabAlias";
import type { LeaveItem, RequestTemplate } from "@/components/work/OpsView";
import { workTabs } from "./tabs";
import { SCOPE_COOKIE, rememberedScope, scopeParams } from "./scope";
import type { GoalsData } from "@/components/work/GoalsView";
import { canManageTeams } from "@/lib/viewer";
import { dayParam } from "@/components/ui/datePages";
import type { Approval, CalEvent, FieldDef, Project, Task } from "@/components/work/types";
import type { Metadata } from "next";

/** The tab's page title ("Lịch · Công việc"; Việc is just "Công việc"). */
export async function workMetadata(tab: WorkTabKey): Promise<Metadata> {
  const tx = await getT();
  const found = workTabs(tx).find((x) => x.key === tab);
  return { title: found && found.key !== "tasks" ? `${found.label} · ${tx("work.page.cong_viec")}` : tx("work.page.cong_viec") };
}

export type WorkSearch = {
  u?: string;
  new?: string;
  scope?: string;
  id?: string;
  project?: string;
  when?: string;
  run?: string;
  archived?: string;
  view?: string;
  label?: string;
  folder?: string;
  section?: string;
  q?: string;
  days?: string;
  period?: string;
  date?: string;
};

/**
 * Work: one place for tasks, projects, documents, calendar, approvals and decisions, each tab at its own address
 * (/app/work/tasks, /app/work/calendar…). A tab whose main read fails (a busy server's 429, a restart) shows a retry
 * where its content goes; the tabs above and the rest of the app keep working. Redirects (sign-in) pass through.
 */
export async function WorkTabPage(tab: WorkTabKey, searchParams: Promise<WorkSearch>) {
  try {
    return await WorkTab(tab, await searchParams);
  } catch (e) {
    unstable_rethrow(e);
    if (e instanceof GatewayError && e.status === 404) notFound();
    return <ReadFailed status={e instanceof GatewayError ? e.status : 500} />;
  }
}

async function WorkTab(tab: WorkTabKey, sp: WorkSearch) {
  const tx = await getT();
  // A destination the deployment left out (DISABLED_FEATURES) does not exist, by its address either.
  if (tab === "docs" || tab === "whiteboards" || tab === "calendar") await requireFeature(tab);
  // Only the tabs that list or pick projects load them (the rest stay one round trip).
  const needsProjects = ["tasks", "calendar", "whiteboards"].includes(tab);
  // Started now, awaited where needed: the tab's own data loads in parallel instead of after the list.
  // The project list feeds pickers and the board's crumb here (the Projects view reads its own): if it fails, those
  // pickers come up empty rather than the whole tab failing.
  const projectsP = needsProjects ? gw<{ projects: Project[] }>("/api/work/projects").catch(() => ({ projects: [] as Project[] })) : Promise.resolve({ projects: [] as Project[] });
  // Việc without a scope in the link (the sidebar, the bottom bar, ⌘K) opens the scope this person used last, else
  // "Việc của tôi": a staff member lands on their own work, not on whichever project happens to come first.
  const jar = tab === "tasks" ? await cookies() : null;
  const lastBoard = jar?.get("wos_board")?.value;
  const explicit = !!(sp.scope || sp.project || sp.view === "projects" || sp.view === "mine");
  const q = tab === "tasks" && !explicit ? { ...sp, ...scopeParams(await rememberedScope(jar?.get(SCOPE_COOKIE)?.value)) } : sp;
  // Việc & dự án: when the scope is a project, fetch its board right away (in parallel with the project list).
  const boardGuess = tab === "tasks" && q.view !== "list" && q.view !== "gantt" && q.project ? q.project : undefined;
  const boardP = boardGuess ? gw<BoardData>(`/api/work/projects/${boardGuess}/board`).catch(() => null) : Promise.resolve(null);
  const fieldsP =
    tab === "tasks" ? gw<{ fields: FieldDef[] }>("/api/work/custom-fields").catch(() => ({ fields: [] as FieldDef[] })) : Promise.resolve({ fields: [] as FieldDef[] });
  const projects = await projectsP;

  let body: React.ReactNode = null;
  if (tab === "goals") {
    const data = await gw<GoalsData>(`/api/work/goals${sp.period ? `?period=${encodeURIComponent(sp.period)}` : ""}`);
    body = (
      <>
        <TasksNav active="goals" />
        <GoalsView data={data} />
      </>
    );
  } else if (tab === "tasks") {
    // Kanban first: a project's board (the one opened last, else the first project); then my tasks,
    // what I handed out and all projects.
    const fields = (await fieldsP).fields;
    const find = (id?: string) => projects.projects.find((p) => p.id === id)?.id;
    // A remembered project that is gone (archived, removed, no longer shared) falls back to my tasks.
    const gone = !explicit && q.project !== undefined && !find(q.project);
    const sub = q.view === "projects" ? "projects" : q.scope === "owned" ? "owned" : gone || q.scope === "assigned" || q.view === "mine" ? "mine" : "board";
    // Old links without a project (?tab=board, ?view=list) still open a board: the last one viewed, else the first.
    const projectId = sub === "board" ? (find(q.project) ?? find(lastBoard) ?? projects.projects[0]?.id) : undefined;
    let inner: React.ReactNode;
    const scope: Scope = projectId ? { project: projectId } : sub === "owned" ? "owned" : sub === "mine" ? "mine" : "projects";
    let views: React.ReactNode = null;
    // One row above the content (drawn by the view's own toolbar): what to look at, the scope as the title, on the
    // left; search, filters, display, how to see it and + Việc mới on the right.
    const lead = (
      <>
        {/* The tabs above name the section; an open project adds its crumb (Dự án › Tên dự án ▾) to switch projects. */}
        <ScopeCrumb scope={scope} projects={projects.projects} />
      </>
    );
    if (projectId) {
      const mode = q.view === "list" ? "list" : q.view === "gantt" ? "gantt" : "board";
      const base = `/app/work/tasks?project=${projectId}`;
      views = (
        <IconSwitch
          label={tx("work.page.viewLabel")}
          value={mode}
          options={[
            { value: "board", label: tx("work.nav.board"), icon: <BoardIcon />, href: base },
            { value: "list", label: tx("work.nav.list"), icon: <ListIcon />, href: `${base}&view=list` },
            { value: "gantt", label: "Gantt", icon: <GanttIcon />, href: `${base}&view=gantt` },
          ]}
        />
      );
      const year = new Date().getFullYear();
      inner =
        mode === "gantt" ? (
          <>
            {/* A timeline needs width: on phones the chart gives way to a pointer to the list (same tasks, readable). */}
            <div className="bg-surface shadow-card grid gap-2 rounded-xl p-4 text-sm sm:hidden">
              <p className="text-ink m-0 font-medium">{tx("taskActions.ganttPhone")}</p>
              <p className="text-ink-2 m-0">{tx("taskActions.ganttPhoneHint")}</p>
              <Link href={`${base}&view=list`} className="font-medium">
                {tx("taskActions.ganttOpenList")}
              </Link>
            </div>
            <div className="max-sm:hidden">
              <GanttView
                initial={await gw<GanttData>(`/api/work/projects/${projectId}/timeline`)}
                now={Date.now()}
                holidays={(
                  await Promise.all(
                    [year, year + 1].map((y) =>
                      gw<{ holidays: { day: string; name: string }[] }>(`/api/employee/holidays?year=${y}`).catch(() => ({ holidays: [] as { day: string; name: string }[] })),
                    ),
                  )
                ).flatMap((h) => h.holidays)}
                lead={lead}
                views={views}
              />
            </div>
          </>
        ) : mode === "board" ? (
          <BoardLoader
            initial={(projectId === boardGuess ? await boardP : null) ?? (await gw<BoardData>(`/api/work/projects/${projectId}/board`))}
            projects={projects.projects}
            lead={lead}
            views={views}
          />
        ) : (
          <TaskList
            tasks={(await gw<{ tasks: Task[] }>(`/api/work/tasks?projectId=${projectId}`)).tasks}
            projects={projects.projects}
            openNew={sp.new === "task"}
            fields={fields}
            projectId={projectId}
            lead={lead}
            views={views}
            exportHref={`/app/work/export?projectId=${projectId}`}
          />
        );
    } else if (sub === "projects" || sub === "board") {
      // No project yet: the project list is where the first board is made.
      const list = (await gw<{ projects: Project[] }>(q.archived === "1" ? "/api/work/projects?status=archived" : "/api/work/projects?preview=1")).projects;
      inner = <ProjectList projects={list} openNew={sp.new === "project"} archived={q.archived === "1"} lead={lead} canManageTeams={await canManageTeams()} />;
    } else {
      const kind = sub === "owned" ? "owned" : "assigned";
      const tasks = await gw<{ tasks: Task[] }>(`/api/work/tasks?scope=${kind}`);
      inner = <TaskList tasks={tasks.tasks} projects={projects.projects} openNew={sp.new === "task"} fields={fields} lead={lead} exportHref={`/app/work/export?scope=${kind}`} />;
    }
    body = (
      <>
        <TasksNav active={projectId || sub === "projects" || sub === "board" ? "projects" : "mine"} />
        {inner}
      </>
    );
  } else if (tab === "whiteboards") {
    // Bảng trắng: folders beside the open folder's boards; "Của tôi", a project or a search list boards across folders.
    // A failed folder list leaves the boards on screen with a retry where the tree goes.
    const scope = sp.scope === "mine" ? "mine" : sp.project ? "project" : "all";
    const filtered = scope !== "all" || !!sp.q;
    const qs = new URLSearchParams({ scope });
    if (sp.project) qs.set("projectId", sp.project);
    if (sp.q) qs.set("q", sp.q);
    if (!filtered) qs.set("folderId", sp.folder || "root");
    const [r, folders] = await Promise.all([
      gw<{ whiteboards: WhiteboardSummary[] }>(`/api/work/whiteboards?${qs}`).catch(() => null),
      gw<WbFolders>("/api/work/whiteboards/folders").catch(() => null),
    ]);
    body = (
      <WhiteboardList
        boards={r?.whiteboards ?? null}
        folders={folders}
        folderId={filtered ? null : (sp.folder ?? null)}
        projects={projects.projects}
        scope={scope}
        projectId={sp.project}
        q={sp.q}
        openNew={sp.new === "whiteboard"}
      />
    );
  } else if (tab === "docs" && sp.view === "files") {
    // Tài liệu › Tệp: files like Google Drive, next to the pages.
    const qs = new URLSearchParams();
    if (sp.folder) qs.set("folder", sp.folder);
    if (sp.section) qs.set("section", sp.section);
    if (sp.q) qs.set("q", sp.q);
    const section = (["shared", "recent", "starred", "trash"].includes(sp.section ?? "") ? sp.section : "mine") as "mine" | "shared" | "recent" | "starred" | "trash";
    // My Drive's top level opens with the files used last (Google Drive's "Quick access").
    const top = section === "mine" && !sp.folder && !sp.q;
    const [data, recent] = await Promise.all([
      gw<DriveData>(`/api/work/drive?${qs}`),
      top ? gw<DriveData>("/api/work/drive?section=recent").catch(() => undefined) : Promise.resolve(undefined),
    ]);
    body = <DriveView data={data} section={section} folder={sp.folder} q={sp.q} quick={recent?.items.filter((i) => i.kind === "file").slice(0, 4)} />;
  } else if (tab === "docs") {
    const [home, labelled] = await Promise.all([
      gw<DocsHomeData>("/api/work/docs-home"),
      sp.label
        ? gw<{ documents: PageRow[] }>(`/api/work/docs?label=${encodeURIComponent(sp.label)}`)
            .then((r) => r.documents)
            .catch(() => undefined)
        : Promise.resolve(undefined),
    ]);
    body = <DocsHome data={home} label={sp.label} labelled={labelled} openNew={sp.new === "page"} />;
  } else if (tab === "calendar" && sp.view === "meetings") {
    const when = sp.when === "past" ? "past" : "upcoming";
    const [r, followups] = await Promise.all([
      gw<{ meetings: MeetingRow[] }>(`/api/work/meetings?when=${when}`),
      gw<MeetingFollowups>("/api/work/meetings/followups").catch(() => undefined),
    ]);
    body = <MeetingsView meetings={r.meetings} when={when} projects={projects.projects} followups={followups} />;
  } else if (tab === "calendar") {
    // A link to another date (?date=) starts there; the view then loads its exact week or month itself.
    const day = dayParam(sp.date);
    const from = day ? new Date(`${day}T00:00:00Z`) : new Date();
    if (!day) from.setHours(0, 0, 0, 0);
    const to = new Date(from.getTime() + 14 * 86400e3);
    const ev = await gw<{ events: CalEvent[] }>(`/api/work/calendar/events?from=${from.toISOString()}&to=${to.toISOString()}`);
    body = <CalendarView events={ev.events} projects={projects.projects} from={from.toISOString()} />;
  } else {
    const [incoming, outgoing, leaveIn, leaveMine, me, templates, ws] = await Promise.all([
      gw<{ approvals: Approval[] }>("/api/work/approvals"),
      // What I sent is the "Mine" view; the inbox still works without it.
      gw<{ approvals: Approval[] }>("/api/work/approvals?role=requester").catch(() => ({ approvals: [] as Approval[] })),
      gw<{ requests: LeaveItem[] }>("/api/employee/leave?role=approver").catch(() => ({ requests: [] as LeaveItem[] })),
      gw<{ requests: LeaveItem[] }>("/api/employee/leave").catch(() => ({ requests: [] as LeaveItem[] })),
      gw<{ profile: { managerId: string | null } | null }>("/api/employee/me").catch(() => ({ profile: null })),
      gw<{ templates: RequestTemplate[]; canManage: boolean }>("/api/work/request-templates").catch(() => ({ templates: [] as RequestTemplate[], canManage: false })),
      // The workspace currency (Admin › Settings › `config.currency`) preselects the request form; unset, the
      // workspace's zone picks it (defaultCurrency).
      gw<{ config?: { currency?: string | null } }>("/api/platform/workspace").catch(() => ({ config: { currency: null } })),
    ]);
    body = (
      <OpsView
        incoming={incoming.approvals}
        outgoing={outgoing.approvals}
        leaveIn={leaveIn.requests}
        leaveMine={leaveMine.requests}
        managerId={me.profile?.managerId ?? null}
        templates={templates.templates}
        canManageTemplates={templates.canManage}
        defaultCurrency={defaultCurrency(ws.config?.currency, await getTimeZone(), await getLocale())}
        openNew={sp.new === "request" || sp.new === "approval"}
      />
    );
  }

  return body;
}
