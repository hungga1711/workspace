"use client";

import { PersonChip } from "@/components/chat/PersonTrigger";
import { FormField } from "./FormField";
import { DateField } from "@/components/ui/DateField";
import { Checkbox } from "@/components/ui/Checkbox";
import { useT, useFormat } from "@/lib/i18n/client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { Avatar, AvatarStack, useDirectory } from "@/lib/people";
import { btn, btnPrimary, chip, chipBlock, chipOk, chipWarn, cx, input, textarea } from "@/lib/ui";
import { FlowLine, FlowSpark } from "./Velocity";
import { UpdateHealth } from "./ProjectStatus";
import { ProjectBadge } from "@/components/ui/ProjectBadge";
import { Modal } from "@/components/ui/Modal";
import { Field } from "@/components/ui/bits";
import { ArrowRightIcon, ChartIcon, ClockIcon, FilterIcon, FlagIcon, FolderIcon, PlusIcon } from "@/components/app/icons";
import { card } from "@/components/ui/Bento";
import { SpotArea } from "@/components/ui/SpotArea";
import { SlimEmpty, StatStrip } from "./progressUi";
import { SearchToggle, ToolbarPopover } from "./ToolbarPopover";
import type { Project } from "./types";
import { AssigneeSelect } from "./TaskFields";
import { Picker } from "@/components/ui/Picker";
import { PeoplePicker } from "@/components/chat/NewConversation";
import { daysUntil, projectHealthOf, reasonText, type Health } from "@/lib/health";
import { projectHref, taskHref } from "@/lib/links";

// One health rule for every screen (lib/health.ts: the work module's answer, or the same rule as a fallback).
const health = (p: Project): Health => projectHealthOf(p);
const ORDER: Health[] = ["behind", "at_risk", "on_track", "not_started", "done"];
// Health is a coloured lozenge and the progress bar takes the same colour, so a late project is red twice over.
// A dot and quiet words per row, not a lozenge: eleven red lozenges in a column said nothing.
const CHIP: Record<Health, string> = { done: chipOk, on_track: chipOk, at_risk: chipWarn, behind: chipBlock, not_started: chip };

/**
 * All projects as cards: progress, health, what is late or at risk, the deadline and who is on it.
 * A card opens the project's board inside Work, so the tabs stay.
 */
export function ProjectList({
  projects,
  openNew,
  archived = false,
  toolbar,
  lead,
  views,
  canManageTeams = false,
}: {
  projects: Project[];
  openNew: boolean;
  archived?: boolean;
  /** The Work bar (my tasks / handed out / projects), shown at the start of this row. */
  toolbar?: React.ReactNode;
  /** The page's scope title (left) and view switch (right), drawn in this one toolbar row. */
  lead?: React.ReactNode;
  views?: React.ReactNode;
  /** May make a new team for a project (member.manage). */
  canManageTeams?: boolean;
}) {
  const tx = useT();
  const [creating, setCreating] = useState(openNew);
  const [q, setQ] = useState("");
  const [onlyMine, setOnlyMine] = useState(false);
  const shown = projects
    .filter((p) => (!q || `${p.name} ${p.code}`.toLowerCase().includes(q.toLowerCase())) && (!onlyMine || p.mine))
    .sort((a, b) => ORDER.indexOf(health(a)) - ORDER.indexOf(health(b)) || b.openTasks - a.openTasks);
  // The three-level risk scale (Trễ hạn / Sắp trễ / Đúng tiến độ), plus done and "no tasks yet".
  const healthLabel: Record<Health, string> = {
    behind: tx("work.projectlist.h_risk"),
    at_risk: tx("work.projectlist.h_watch"),
    on_track: tx("work.projectlist.h_ok"),
    not_started: tx("work.projectlist.h_none"),
    done: tx("goals.health.done"),
  };
  const behind = projects.filter((p) => health(p) === "behind").length;
  const late = projects.reduce((n, p) => n + (p.overdueTasks ?? 0), 0);
  // The week's pace across projects, not a lifetime "% done" (which falls whenever work is added to a board).
  const doneWeek = projects.reduce((n, p) => n + (p.flow?.thisWeek.done ?? 0), 0);
  const addedWeek = projects.reduce((n, p) => n + (p.flow?.thisWeek.added ?? 0), 0);
  return (
    <>
      <div role="toolbar" aria-label={tx("work.board.toolbar")} className="mb-4 flex flex-wrap items-center gap-2">
        {lead ? <div className="flex min-w-0 items-center gap-2 max-sm:w-full">{lead}</div> : null}
        {toolbar}
        <span className="ml-auto flex min-w-0 items-center gap-2">
          {projects.length ? (
            <>
              {projects.length > 6 ? <SearchToggle value={q} onChange={setQ} label={tx("work.projectlist.search")} /> : null}
              <ToolbarPopover icon={<FilterIcon className="size-4" />} label={tx("work.board.filters")} count={onlyMine ? 1 : 0}>
                <Checkbox label={tx("work.projectlist.onlyMine")} checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} />
                <Link
                  href={archived ? "/app/work/tasks?view=projects" : "/app/work/tasks?view=projects&archived=1"}
                  className="text-ink-2 hover:text-ink border-hairline border-t pt-2.5 text-sm no-underline"
                >
                  {archived ? tx("work.projectlist.xem_du_an_dang") : tx("work.projectlist.xem_du_an_da")}
                </Link>
              </ToolbarPopover>
            </>
          ) : null}
          {views}
          {!archived ? (
            <button
              type="button"
              className={cx(btnPrimary, "max-sm:w-9 max-sm:px-0")}
              onClick={() => setCreating(true)}
              aria-label={tx("work.projectlist.du_an_moi")}
              title={tx("work.projectlist.du_an_moi")}
            >
              <PlusIcon className="size-4" />
              <span className="max-sm:hidden">{tx("work.projectlist.du_an_moi")}</span>
            </button>
          ) : null}
        </span>
      </div>
      {projects.length === 0 ? (
        <SlimEmpty
          icon={<FolderIcon />}
          tone="sky"
          title={tx("work.projectlist.chua_co_du_an")}
          action={
            !archived ? (
              <button type="button" className={btn} onClick={() => setCreating(true)}>
                {tx("work.projectlist.tao_du_an")}
              </button>
            ) : undefined
          }
        >
          {tx("work.projectlist.du_an_gom_viec")}
        </SlimEmpty>
      ) : (
        // A company runs a handful of projects, so each is a full-width block after Linear's project view:
        // name and status, lead and dates, a bar with a tick where it should be by now (time elapsed from start to
        // due), then the latest progress note and the work in flight.
        // The company's figures first (Home's strip): how many run, how many are behind, late work, overall progress.
        <SpotArea className="grid grid-cols-[minmax(0,1fr)] gap-4">
          {!archived ? (
            <StatStrip
              label={tx("work.projectlist.stats")}
              items={[
                { label: tx("work.projectlist.statProjects"), value: projects.length, icon: <FolderIcon />, tone: "sky" },
                { label: tx("work.projectlist.h_risk"), value: behind, icon: <FlagIcon />, tone: "red", alert: behind > 0, quiet: !behind },
                { label: tx("work.projectlist.statLate"), value: late, icon: <ClockIcon />, tone: "tangerine", quiet: !late },
                { label: tx("work.projectlist.statDoneWeek", { added: addedWeek }), value: doneWeek, icon: <ChartIcon />, tone: "green" },
              ]}
            />
          ) : null}
          {shown.map((p) => (
            <ProjectBlock key={p.id} p={p} healthLabel={healthLabel[health(p)]} />
          ))}
          {!shown.length ? <SlimEmpty icon={<FilterIcon />} tone="violet" title={tx("work.projectlist.noMatch")} /> : null}
        </SpotArea>
      )}
      {creating ? <NewProjectModal onClose={() => setCreating(false)} canManageTeams={canManageTeams} /> : null}
    </>
  );
}

function ProjectBlock({ p, healthLabel }: { p: Project; healthLabel: string }) {
  const tx = useT();
  const { shortDate, ago } = useFormat();
  const dir = useDirectory();
  const h = health(p);
  const why = reasonText(tx, { kind: "project", late: p.overdueTasks, blocked: p.blockedTasks ?? 0, daysLeft: p.daysLeft ?? daysUntil(p.dueAt) });
  const href = `/app/work/tasks?project=${p.id}`;
  const left = p.daysLeft ?? daysUntil(p.dueAt);
  const others = p.people?.filter((x) => x !== p.ownerId) ?? [];
  const u = p.latestUpdate;
  const st = p.statusUpdate;
  return (
    // The whole card opens the board (the name's link is stretched over it): people do not know to click the name.
    // The task links inside sit above it.
    <article aria-label={p.name} className={cx(card, "group/tile grid min-w-0 cursor-pointer grid-cols-[minmax(0,1fr)] gap-5 rounded-xl p-6 max-sm:p-4")}>
      <header className="flex min-w-0 items-start gap-4">
        <ProjectBadge id={p.id} name={p.name} size="lg" />
        <div className="grid min-w-0 flex-1 gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <Link
              href={href}
              title={p.name}
              className="text-ink focus-visible:after:outline-accent truncate text-lg font-semibold tracking-[-0.02em] no-underline after:absolute after:inset-0 after:rounded-xl after:content-[''] focus-visible:outline-none focus-visible:after:outline-2 group-hover/tile:underline"
            >
              {p.name}
            </Link>
            <span className={cx(CHIP[h], "relative z-[1]")} title={why ?? undefined}>
              {healthLabel}
            </span>
          </div>
          <div className="text-ink-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
            {/* Above the card's stretched link, like the task links. */}
            <PersonChip userId={p.ownerId} dense className="relative z-[1]" nameClassName="text-ink" />
            <span aria-hidden="true">·</span>
            <span className="tabular-nums">
              {p.createdAt ? shortDate(p.createdAt) : "—"} → {p.dueAt ? shortDate(p.dueAt) : tx("work.projectlist.noDue")}
            </span>
            {p.dueAt && left !== null && h !== "done" ? (
              <span className={cx("tabular-nums", left < 0 && "text-block")}>
                ({left < 0 ? tx("goals.reason.overdueBy", { count: -left }) : tx("goals.reason.daysLeft", { count: left })})
              </span>
            ) : null}
          </div>
        </div>
        <span className="flex shrink-0 items-center gap-3">
          {others.length ? (
            <span className="max-sm:hidden">
              <AvatarStack ids={others} max={5} />
            </span>
          ) : null}
          <Link
            href={href}
            tabIndex={-1}
            aria-hidden="true"
            className={cx(
              btn,
              "group-hover/tile:bg-ink group-hover/tile:text-on-brand relative z-[1] no-underline max-sm:w-9 max-sm:px-0 [&_svg]:transition-transform group-hover/tile:[&_svg]:translate-x-0.5",
            )}
          >
            <span className="max-sm:hidden">{tx("work.projectlist.openBoard")}</span>
            <ArrowRightIcon className="size-3.5" />
          </Link>
        </span>
      </header>

      {/* The pace (done and added this week, 8 weeks of both) in place of "% done": tasks join a board at any time,
          so a percentage falls while the team ships (user, 2026-11-07). */}
      <div className="flex min-w-0 flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div className="text-ink-2 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-[13px] tabular-nums">
          {p.flow ? <FlowLine done={p.flow.thisWeek.done} added={p.flow.thisWeek.added} inProgress={p.flow.inProgress} stuck={p.flow.stuck} /> : null}
          {p.overdueTasks ? <span className="text-block font-medium">{tx("goals.reason.late", { count: p.overdueTasks })}</span> : null}
          {p.atRiskTasks ? <span>{tx("work.projectlist.atRiskN", { count: p.atRiskTasks })}</span> : null}
          {p.blockedTasks ? <span>{tx("goals.reason.blocked", { count: p.blockedTasks })}</span> : null}
        </div>
        {p.flow ? <FlowSpark done={p.flow.done} added={p.flow.added} /> : null}
      </div>

      <div className="border-hairline grid grid-cols-[minmax(0,1fr)] gap-5 border-t pt-5 md:grid-cols-2 md:gap-8">
        <section className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-2">
          <h3 className="text-ink-2 m-0 text-xs font-medium uppercase tracking-[0.08em]">{tx("work.projectlist.latestUpdate")}</h3>
          {st ? (
            <div className="flex min-w-0 gap-3">
              <Avatar id={st.authorId} size="sm" />
              <div className="grid min-w-0 gap-0.5">
                <span className="text-ink-2 flex flex-wrap items-center gap-x-2 text-xs">
                  <span>
                    <span className="text-ink font-medium">{dir.name(st.authorId)}</span> · {ago(st.at)}
                  </span>
                  <UpdateHealth health={st.health} />
                </span>
                <p className="text-ink m-0 line-clamp-2 text-sm">{st.body}</p>
              </div>
            </div>
          ) : u ? (
            <div className="flex min-w-0 gap-3">
              <Avatar id={u.authorId} size="sm" />
              <div className="grid min-w-0 gap-0.5">
                <span className="text-ink-2 text-xs">
                  <span className="text-ink font-medium">{dir.name(u.authorId)}</span> · {ago(u.at)} ·{" "}
                  <Link href={taskHref({ id: u.taskId, code: u.taskCode })} className="text-ink-2 hover:text-ink relative z-[1] tabular-nums">
                    {u.taskCode}
                  </Link>
                </span>
                <p className="text-ink m-0 line-clamp-2 text-sm">{u.text}</p>
              </div>
            </div>
          ) : (
            <p className="text-ink-2 m-0 text-sm">{tx("work.projectlist.noUpdate")}</p>
          )}
        </section>
        <section className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-1">
          <h3 className="text-ink-2 m-0 mb-1 text-xs font-medium uppercase tracking-[0.08em]">{tx("work.projectlist.inFlight")}</h3>
          {p.inFlight?.length ? (
            <ul className="m-0 grid list-none grid-cols-[minmax(0,1fr)] gap-0.5 p-0">
              {p.inFlight.map((t) => (
                <li key={t.id}>
                  <Link href={taskHref(t)} className="hover:bg-hover relative z-[1] -mx-2 flex min-h-8 min-w-0 items-center gap-2.5 rounded-md px-2 text-sm no-underline">
                    <span className="text-ink-2 shrink-0 text-xs tabular-nums">{t.code}</span>
                    <span className="text-ink min-w-0 flex-1 truncate">{t.title}</span>
                    {t.assigneeId ? <Avatar id={t.assigneeId} size="xs" /> : null}
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-ink-2 m-0 text-sm">{tx("work.projectlist.noInFlight")}</p>
          )}
        </section>
      </div>
    </article>
  );
}

/**
 * "Dự án mới": what it is (name, description, due date) and who works on it, decided at once: the lead, and the team
 * whose members get the Manager role's TEAM-scoped rights on it (ADR-0018). People who manage teams can make a new
 * team for the project here; everyone else picks an existing one.
 */
function NewProjectModal({ onClose, canManageTeams }: { onClose: () => void; canManageTeams: boolean }) {
  const tx = useT();
  const router = useRouter();
  const dir = useDirectory();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [due, setDue] = useState("");
  const [owner, setOwner] = useState<string | null>(dir.me);
  const [teams, setTeams] = useState<{ id: string; name: string; memberIds: string[] }[] | null>(null);
  // "" no team, "new" a new team of `people`, else an existing team's id.
  const [team, setTeam] = useState("");
  const [people, setPeople] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void api<{ teams: { id: string; name: string; memberIds: string[] }[] }>("identity/teams")
      .then((r) => live && setTeams(r.teams))
      .catch(() => live && setTeams([]));
    return () => {
      live = false;
    };
  }, []);
  const chosen = teams?.find((x) => x.id === team);
  const submit = async () => {
    if (!name.trim()) {
      setError(tx("work.projectlist.dat_ten_du_an"));
      return;
    }
    setBusy(true);
    try {
      let teamId: string | null = team && team !== "new" ? team : null;
      if (team === "new") {
        const members = [...new Set([...(owner ? [owner] : []), ...people])];
        teamId = (await api<{ id: string }>("identity/teams", { method: "POST", body: { name: name.trim().slice(0, 80), memberIds: members } })).id;
      }
      const p = await api<{ id: string }>("work/projects", {
        method: "POST",
        body: { name, description, teamId, ...(owner ? { ownerId: owner } : {}), dueAt: due ? new Date(`${due}T17:00:00`).toISOString() : null },
      });
      onClose();
      router.push(projectHref(p));
    } catch (e) {
      setBusy(false);
      setError((e as { status?: number }).status === 403 ? tx("work.projectlist.ban_khong_co_quyen") : tx("work.projectlist.chua_tao_duoc_du"));
    }
  };
  const teamOptions = [
    { value: "", label: tx("work.projectlist.noTeam") },
    ...(canManageTeams ? [{ value: "new", label: tx("work.projectlist.newTeam") }] : []),
    ...(teams ?? []).map((x) => ({ value: x.id, label: x.name })),
  ];
  return (
    <Modal
      title={tx("work.projectlist.du_an_moi")}
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className={btn} onClick={onClose}>
            {tx("work.projectlist.huy")}
          </button>
          <button type="button" className={btnPrimary} disabled={busy} onClick={() => void submit()}>
            {tx("work.projectlist.tao_du_an")}
          </button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-5">
        <Field label={tx("work.projectlist.ten_du_an")} error={error}>
          <input className={input} value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={120} placeholder={tx("work.projectlist.ra_mat_ung_dung")} />
        </Field>
        <Field label={tx("work.projectlist.description")}>
          <textarea
            className={cx(textarea, "min-h-24")}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={5000}
            placeholder={tx("work.projectlist.descriptionPh")}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label={tx("work.projectlist.lead")}>
            <AssigneeSelect id="new-project-lead" value={owner} onChange={setOwner} />
          </FormField>
          <FormField label={tx("work.projectlist.han_hoan_thanh")}>
            <DateField label={tx("work.projectlist.han_hoan_thanh")} value={due} onChange={setDue} />
          </FormField>
        </div>

        <fieldset className="border-divider m-0 grid gap-3 border-t p-0 pt-4">
          <legend className="float-left mb-1 w-full p-0">
            <span className="block text-sm font-semibold">{tx("work.projectlist.access")}</span>
            <span className="text-ink-2 block text-xs">
              {tx("work.projectlist.accessHint")}
              {/* Edit project offers the team only when there is one to pick or one can be made: promise it only then. */}
              {canManageTeams || teams?.length ? ` ${tx("work.projectlist.accessLater")}` : null}
            </span>
          </legend>
          <Field label={tx("work.projectlist.team")}>
            <Picker variant="field" label={tx("work.projectlist.team")} value={team} onChange={setTeam} options={teamOptions} />
          </Field>
          {team === "new" ? (
            <Field label={tx("work.projectlist.teamPeople")} hint={tx("work.projectlist.teamPeopleHint")}>
              <PeoplePicker selected={people} onChange={setPeople} exclude={owner ? [owner] : []} />
            </Field>
          ) : chosen ? (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <AvatarStack ids={chosen.memberIds} max={8} />
              <span className="text-ink-2">{tx("work.projectlist.teamMembers", { count: chosen.memberIds.length })}</span>
            </div>
          ) : (
            <p className="text-ink-2 m-0 text-sm">{tx("work.projectlist.noTeamHint")}</p>
          )}
        </fieldset>
      </div>
    </Modal>
  );
}
