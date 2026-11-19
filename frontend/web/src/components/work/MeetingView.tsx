"use client";

import { PersonChip } from "@/components/chat/PersonTrigger";
import { FormField } from "./FormField";
import { DateField } from "@/components/ui/DateField";
import { budgetMessage } from "@/lib/ai-spend";
import { MarkdownToolbar, markdownShortcut } from "@/components/ui/MarkdownToolbar";
import type { T } from "@/lib/i18n/core";
import { useT, useFormat } from "@/lib/i18n/client";
import Link from "next/link";
import { ScreenCrumb } from "@/components/shell/ScreenTitle";
import { EventRecordings, MeetNowButton } from "@/components/meet/MeetNow";
import { useRouter } from "next/navigation";
import { useState, useRef } from "react";
import { api } from "@/lib/client";
import { Markdown } from "@/lib/markdown";
import { Avatar, useDirectory } from "@/lib/people";
import { btn, btnGhost, btnPrimary, btnSm, chip, cx, input } from "@/lib/ui";
import { Modal } from "@/components/ui/Modal";
import { Field } from "@/components/ui/bits";
import { PeoplePicker } from "@/components/chat/NewConversation";
import { BotIcon, CalendarIcon, CheckIcon, ChecklistIcon, FileIcon, FlagIcon, ListIcon, PencilIcon, PlusIcon, UsersIcon } from "@/components/app/icons";
import { IconTile } from "@/components/ui/Bento";
import { AssigneeSelect } from "./TaskFields";
import { REPEAT } from "./recurrence";
import { Rsvp } from "./Rsvp";
import { at, fromZonedInput, parts, zonedInput } from "./calTime";
import type { Project, Task } from "./types";
import { meetingHref, projectHref, taskHref } from "@/lib/links";

export interface MeetingDetail {
  event: {
    id: string;
    /** Readable code (H-012, H-012-3 in a series). */
    code?: string | null;
    title: string;
    kind: string;
    startsAt: string;
    endsAt: string;
    organizerId: string;
    location: string;
    projectId: string | null;
    agenda: string;
    notes: string;
    version: number;
    updatedAt: string;
  };
  attendees: { userId: string; response: string }[];
  actionItems: Task[];
  series?: {
    id: string;
    recurrence: string | null;
    previous: { id: string; code?: string | null; startsAt: string } | null;
    next: { id: string; code?: string | null; startsAt: string } | null;
  } | null;
}
interface Extracted {
  summary: string;
  actions: { title: string; assigneeId: string | null; due: string | null }[];
  decisions: { title: string }[];
}

const RESPONSE = (tx: T): Record<string, { label: string; tone: string }> => ({
  accepted: { label: tx("work.meetingview.tham_gia_trang_thai"), tone: "text-ok" },
  declined: { label: tx("work.meetingview.tu_choi"), tone: "text-block" },
  pending: { label: tx("work.meetingview.chua_phan_hoi"), tone: "text-ink-2" },
});

/** "dd/MM" or "dd/MM/yyyy" from the AI → an ISO end-of-day due date in the current year. */
function dueFromHint(hint: string | null): string | null {
  const m = hint?.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?/);
  if (!m) return null;
  const p = (n: number) => String(n).padStart(2, "0");
  const key = `${m[3] ?? parts(new Date()).key.slice(0, 4)}-${p(Number(m[2]))}-${p(Number(m[1]))}`;
  const d = at(key, 17 * 60);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Meeting page: time and invitees, RSVP, a shared agenda and minutes
 * (organizer and attendees co-edit, version-checked), and action items that are real tasks
 * linked back here. AI proposes action items and decisions from the minutes; people confirm each.
 */
export function MeetingView({
  detail,
  projects,
  aiEnabled,
  peek = false,
}: {
  detail: MeetingDetail;
  projects: Project[];
  aiEnabled: boolean;
  /** Inside the Peek drawer (its header shows the title). */ peek?: boolean;
}) {
  const { dayLabel, dayInline, time, dueLabel } = useFormat();
  const tx = useT();
  const router = useRouter();
  const dir = useDirectory();
  const [m, setM] = useState(detail);
  const e = m.event;
  const organizer = e.organizerId === dir.me;
  const mine = m.attendees.find((a) => a.userId === dir.me);
  const [editing, setEditing] = useState<"agenda" | "notes" | null>(e.notes ? null : new Date(e.endsAt) < new Date() ? "notes" : null);
  const [draft, setDraft] = useState("");
  const noteArea = useRef<HTMLTextAreaElement | null>(null);
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "err" } | null>(null);
  const [details, setDetails] = useState(false);
  const [ai, setAi] = useState<Extracted | "loading" | null>(null);
  const [newItem, setNewItem] = useState({ title: "", assigneeId: null as string | null, due: "" });
  const project = projects.find((p) => p.id === e.projectId);
  const past = new Date(e.endsAt) < new Date();

  const patch = async (body: Record<string, unknown>, ok: string) => {
    setMsg(null);
    try {
      const next = await api<MeetingDetail>(`work/meetings/${e.id}`, { method: "PATCH", body: { expectedVersion: e.version, ...body } });
      setM(next);
      setMsg({ text: ok, tone: "ok" });
      return true;
    } catch (err) {
      const s = (err as { status?: number }).status;
      setMsg({
        tone: "err",
        text: s === 409 ? tx("work.meetingview.nguoi_khac_vua_sua") : s === 403 ? tx("work.meetingview.chi_nguoi_to_chuc") : tx("work.meetingview.chua_luu_duoc"),
      });
      return false;
    }
  };
  const startEdit = (k: "agenda" | "notes") => {
    setDraft(e[k]);
    setEditing(k);
  };
  const saveText = async () => {
    if (editing && (await patch({ [editing]: draft }, editing === "agenda" ? tx("work.meetingview.da_luu_chuong_trinh") : tx("work.meetingview.da_luu_bien_ban"))))
      setEditing(null);
  };
  const respond = async (response: "accepted" | "declined") => {
    if (past) return;
    await api(`work/calendar/events/${e.id}/respond`, { method: "POST", body: { response } });
    setM((x) => ({ ...x, attendees: x.attendees.map((a) => (a.userId === dir.me ? { ...a, response } : a)) }));
  };
  const addItem = async (title: string, assigneeId: string | null, dueAt: string | null) => {
    const t = await api<Task>("work/tasks", { method: "POST", body: { title, assigneeId, dueAt, projectId: e.projectId, source: { type: "meeting", eventId: e.id } } });
    setM((x) => ({ ...x, actionItems: [...x.actionItems, t] }));
    return t;
  };
  const toggle = async (t: Task) => {
    const status = t.status === "done" ? "todo" : "done";
    const u = await api<Task>(`work/tasks/${t.id}`, { method: "PATCH", body: { expectedVersion: t.version, status } });
    setM((x) => ({ ...x, actionItems: x.actionItems.map((i) => (i.id === t.id ? u : i)) }));
  };
  const extract = async () => {
    setAi("loading");
    try {
      const r = await api<Extracted>("ai/extract", {
        method: "POST",
        body: {
          kind: "meeting",
          subjectId: e.id,
          title: e.title,
          text: `${e.agenda ? `${tx("work.meetingview.ai_chuong_trinh")}:\n${e.agenda}\n\n` : ""}${tx("work.meetingview.ai_bien_ban")}:\n${e.notes}`,
          people: m.attendees.map((a) => ({ id: a.userId, name: dir.name(a.userId) })),
        },
      });
      setAi(r);
    } catch (err) {
      setAi(null);
      setMsg({ tone: "err", text: budgetMessage(tx, err) ?? tx("work.meetingview.ai_chua_doc_duoc") });
    }
  };
  // Agenda and notes as Home tiles: a white card by its ring, led by a tinted icon tile.
  const editor = (k: "agenda" | "notes", title: string, empty: string, hint: string) => (
    <section aria-labelledby={`${k}-h`} className="bg-surface shadow-card rounded-xl">
      <div className="flex min-h-8 items-center gap-3 px-4 pt-4 sm:px-5">
        <IconTile tone={k === "agenda" ? "sky" : "tangerine"}>{k === "agenda" ? <ListIcon /> : <FileIcon />}</IconTile>
        <h2 id={`${k}-h`} className="m-0 flex-1 text-sm font-semibold tracking-[-0.01em]">
          {title}
        </h2>
        {editing === k ? null : (
          <button type="button" className={cx(btnGhost, btnSm)} onClick={() => startEdit(k)}>
            <PencilIcon className="size-3.5" />
            {e[k] ? tx("work.meetingview.sua") : tx("work.meetingview.viet")}
          </button>
        )}
      </div>
      {editing === k ? (
        <div className="grid gap-2 p-3 sm:px-4">
          <div className="ring-hairline focus-within:ring-edge overflow-hidden rounded-lg ring-1 ring-inset transition-shadow">
            <MarkdownToolbar target={noteArea} value={draft} onChange={setDraft} />
            <textarea
              ref={noteArea}
              aria-label={tx("work.meetingview.noi_dung", { p0: title.toLowerCase() })}
              className="block min-h-48 w-full resize-y bg-transparent px-3 py-2.5 text-sm/6 outline-none"
              value={draft}
              onChange={(x) => setDraft(x.target.value)}
              onKeyDown={(x) => markdownShortcut(x, draft, setDraft)}
              autoFocus
              placeholder={hint}
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-ink-2 flex-1 text-xs">{tx("work.meetingview.ho_tro_markdown_dam")}</span>
            <button type="button" className={btn} onClick={() => setEditing(null)}>
              {tx("work.meetingview.huy")}
            </button>
            <button type="button" className={btnPrimary} onClick={() => void saveText()}>
              {tx("work.meetingview.luu")}
            </button>
          </div>
        </div>
      ) : (
        <div className="px-4 pb-4 pt-2 text-sm sm:px-5">{e[k] ? <Markdown source={e[k]} /> : <p className="text-ink-2 m-0">{empty}</p>}</div>
      )}
    </section>
  );

  return (
    // Full page: left-aligned in the app column (1120px); in the Peek drawer the side column stacks under it.
    <div className="@container max-w-[1120px]">
      {/* The top bar shows "Lịch / <meeting>"; the page keeps the meeting's name as its h1. */}
      {!peek ? <ScreenCrumb label={e.title} /> : null}
      <div className="@4xl:grid-cols-[minmax(0,1fr)_300px] grid gap-8">
        <div className="grid min-w-0 content-start gap-6">
          <div>
            {e.code && !peek ? <p className="text-ink-2 m-0 mb-1 text-xs font-medium uppercase tabular-nums tracking-[0.08em]">{e.code}</p> : null}
            <h1 className={cx("font-display text-ink m-0 text-balance font-semibold tracking-[-0.035em]", peek ? "text-2xl/8" : "text-[28px]/[1.2] max-sm:text-2xl/8")}>
              {e.title}
            </h1>
            <p className="text-ink-2 m-0 mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <CalendarIcon className="size-4" />
              {dayLabel(e.startsAt)}, {time(e.startsAt)}–{time(e.endsAt)}
              {e.location ? <span>· {e.location}</span> : null}
              {past ? <span>{tx("work.meetingview.da_dien_ra")}</span> : null}
              {project ? (
                <Link href={projectHref(project)} className="text-ink-2 hover:text-ink no-underline">
                  {project.name}
                </Link>
              ) : null}
            </p>
            {!past ? <MeetNowButton eventId={e.id} label={tx("meet.joinVideo")} className={cx(btnPrimary, "mt-3")} /> : null}
            <EventRecordings eventId={e.id} />
            {m.series ? (
              <nav className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm" aria-label={tx("work.meetingview.cac_buoi_trong_chuoi")}>
                <span className={chip}>{REPEAT(tx)[m.series.recurrence ?? ""] ?? tx("work.meetingview.dinh_ky")}</span>
                {m.series.previous ? (
                  <Link href={meetingHref(m.series.previous)}>{tx("work.meetingview.buoi_truoc", { p0: dayInline(m.series.previous.startsAt) })}</Link>
                ) : (
                  <span className="text-ink-2">{tx("work.meetingview.buoi_dau_tien")}</span>
                )}
                {m.series.next ? (
                  <Link href={meetingHref(m.series.next)}>{tx("work.meetingview.buoi_sau", { p0: dayInline(m.series.next.startsAt) })}</Link>
                ) : (
                  <span className="text-ink-2">{tx("work.meetingview.buoi_cuoi")}</span>
                )}
              </nav>
            ) : null}
          </div>
          {msg ? (
            <p
              className={cx(
                "m-0 rounded-xl px-3.5 py-2.5 text-sm ring-1 ring-inset",
                msg.tone === "ok" ? "bg-ok-wash text-ok ring-ok/15" : "bg-block-wash text-block ring-block/15",
              )}
              role="status"
            >
              {msg.text}
            </p>
          ) : null}
          {editor("agenda", tx("work.meetingview.chuong_trinh"), tx("work.meetingview.chua_co_chuong_trinh"), tx("work.meetingview.agenda_ph"))}
          {editor(
            "notes",
            tx("work.meetingview.bien_ban"),
            past ? tx("work.meetingview.chua_co_bien_ban") : tx("work.meetingview.bien_ban_duoc_ghi"),
            tx("work.meetingview.notes_ph"),
          )}

          <section aria-labelledby="items-h" className="bg-surface shadow-card rounded-xl p-4 sm:p-5">
            <div className="mb-3 flex min-h-8 flex-wrap items-center gap-3">
              <IconTile tone="green">
                <ChecklistIcon />
              </IconTile>
              <h2 id="items-h" className="m-0 flex-1 text-sm font-semibold tracking-[-0.01em]">
                {tx("work.meetingview.viec_sau_hop")}{" "}
                <span className="text-ink-2 font-normal">
                  {tx("work.meetingview.viec_xong_dem", { p0: m.actionItems.filter((t) => t.status === "done").length, p1: m.actionItems.length })}
                </span>
              </h2>
              {aiEnabled && e.notes ? (
                <button type="button" className={cx(btn, btnSm)} disabled={ai === "loading"} onClick={() => void extract()}>
                  <BotIcon className="size-3.5" />
                  {ai === "loading" ? tx("work.meetingview.ai_dang_doc") : tx("work.meetingview.ai_trich_viec_tu")}
                </button>
              ) : null}
            </div>
            {ai && ai !== "loading" ? (
              <div className="bg-accent-wash ring-accent/15 animate-rise mb-3 rounded-xl p-3 text-sm ring-1 ring-inset" aria-label={tx("work.meetingview.de_xuat_tu_ai")}>
                <p className="mb-2">
                  <b>{tx("work.meetingview.ai_tom_tat")}</b> {ai.summary || tx("work.meetingview.khong_co_gi_noi")}
                </p>
                {ai.actions.length ? (
                  <ul className="m-0 grid list-none gap-1.5 p-0">
                    {ai.actions.map((a, i) => (
                      <li key={i} className="bg-surface flex flex-wrap items-center gap-2 rounded-md px-3 py-2">
                        <span className="min-w-0 flex-1">
                          {a.title}
                          <span className="text-ink-2 text-xs">
                            {a.assigneeId ? ` · ${dir.name(a.assigneeId)}` : ""}
                            {a.due ? tx("work.meetingview.han", { p0: a.due }) : ""}
                          </span>
                        </span>
                        <button
                          type="button"
                          className={cx(btnPrimary, btnSm)}
                          onClick={() =>
                            void addItem(a.title, a.assigneeId, dueFromHint(a.due)).then(() =>
                              setAi((x) => (x && x !== "loading" ? { ...x, actions: x.actions.filter((_, j) => j !== i) } : x)),
                            )
                          }
                        >
                          {tx("work.meetingview.tao_viec")}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-ink-2">{tx("work.meetingview.khong_thay_viec_can")}</p>
                )}
                {ai.decisions.length ? (
                  <ul className="m-0 mt-2 grid list-none gap-1.5 p-0">
                    {ai.decisions.map((d, i) => (
                      <li key={i} className="bg-surface flex items-center gap-2 rounded-md px-3 py-2">
                        <FlagIcon className="text-ink-2 size-4" />
                        <span className="flex-1">{d.title}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <p className="text-ink-2 mt-2 text-xs">{tx("work.meetingview.de_xuat_chi_thanh")}</p>
              </div>
            ) : null}
            <ul className="divide-divider ring-hairline m-0 list-none divide-y overflow-hidden rounded-lg p-0 ring-1 ring-inset">
              {m.actionItems.map((t) => {
                const due = dueLabel(t.dueAt);
                return (
                  <li key={t.id} className="hover:bg-hover/60 flex min-h-11 items-center gap-3 px-3.5 py-2 transition-colors">
                    <button
                      type="button"
                      onClick={() => void toggle(t)}
                      aria-label={t.status === "done" ? tx("work.meetingview.mo_lai", { p0: t.title }) : tx("work.meetingview.hoan_thanh", { p0: t.title })}
                      className={cx("grid size-[18px] shrink-0 place-items-center rounded-full border", t.status === "done" ? "border-ok bg-ok text-white" : "border-ink-2/60")}
                    >
                      {t.status === "done" ? <CheckIcon className="size-3" /> : null}
                    </button>
                    <Link href={taskHref(t)} className={cx("text-ink min-w-0 flex-1 truncate no-underline hover:underline", t.status === "done" && "text-ink-2 line-through")}>
                      {t.title}
                    </Link>
                    {due ? <span className={cx("text-xs tabular-nums", due.overdue && t.status !== "done" ? "text-block" : "text-ink-2")}>{due.text}</span> : null}
                    {t.assigneeId ? <Avatar id={t.assigneeId} size="xs" /> : <span className="text-ink-2 text-xs">{tx("work.meetingview.chua_giao")}</span>}
                  </li>
                );
              })}
              <li className="px-3 py-2">
                <form
                  className="grid grid-cols-[auto_1fr] items-center gap-2 sm:grid-cols-[auto_1fr_160px_150px_auto]"
                  onSubmit={(x) => {
                    x.preventDefault();
                    if (!newItem.title.trim()) return;
                    void addItem(newItem.title, newItem.assigneeId, newItem.due ? at(newItem.due.slice(0, 10), 17 * 60).toISOString() : null).then(() =>
                      setNewItem({ title: "", assigneeId: null, due: "" }),
                    );
                  }}
                >
                  <PlusIcon className="text-ink-2 size-4" />
                  <input
                    aria-label={tx("work.meetingview.viec_moi_sau_hop")}
                    className="h-8 min-w-0 bg-transparent text-sm outline-none"
                    placeholder={tx("work.meetingview.them_viec_sau_hop")}
                    value={newItem.title}
                    onChange={(x) => setNewItem({ ...newItem, title: x.target.value })}
                  />
                  <span className="col-span-2 sm:col-span-1">
                    <AssigneeSelect id="item-assignee" value={newItem.assigneeId} onChange={(v) => setNewItem({ ...newItem, assigneeId: v })} />
                  </span>
                  <DateField variant="button" label={tx("work.meetingview.han_2")} value={newItem.due} onChange={(v) => setNewItem({ ...newItem, due: v })} />
                  <button type="submit" className={cx(btnPrimary, btnSm)} disabled={!newItem.title.trim()}>
                    {tx("work.meetingview.them")}
                  </button>
                </form>
              </li>
            </ul>
          </section>
        </div>

        <aside className="grid content-start gap-5" aria-label={tx("work.meetingview.thong_tin_cuoc_hop")}>
          {mine && !organizer ? (
            <div className="bg-surface shadow-card rounded-xl p-4">
              <p className="m-0 mb-3 text-sm font-semibold tracking-[-0.01em]">{past ? tx("work.rsvp.yourReply") : tx("work.meetingview.ban_se_tham_gia")}</p>
              <Rsvp response={mine.response} past={past} size="md" onRespond={(r) => void respond(r)} className="[&>button]:flex-1" />
            </div>
          ) : null}
          <section className="bg-surface shadow-card rounded-xl p-4" aria-labelledby="att-h">
            <div className="mb-3 flex min-h-8 items-center gap-3">
              <IconTile tone="violet">
                <UsersIcon />
              </IconTile>
              <h2 id="att-h" className="m-0 flex-1 text-sm font-semibold tracking-[-0.01em]">
                {tx("work.meetingview.nguoi_tham_gia")} <span className="text-ink-2 font-normal">{m.attendees.length}</span>
              </h2>
              {organizer ? (
                <button type="button" className={cx(btnGhost, btnSm)} onClick={() => setDetails(true)}>
                  {tx("work.meetingview.sua")}
                </button>
              ) : null}
            </div>
            <ul className="m-0 grid list-none gap-2 p-0">
              {m.attendees.map((a) => (
                <li key={a.userId} className="flex items-center gap-2 text-sm">
                  <span className="flex min-w-0 flex-1">
                    <PersonChip
                      userId={a.userId}
                      size="sm"
                      suffix={a.userId === e.organizerId ? <span className="text-ink-2 text-xs"> {tx("work.meetingview.to_chuc")}</span> : null}
                    />
                  </span>
                  <span className={cx("text-xs", RESPONSE(tx)[a.response]?.tone)}>{RESPONSE(tx)[a.response]?.label}</span>
                </li>
              ))}
            </ul>
          </section>
          {organizer ? (
            <button type="button" className={btn} onClick={() => setDetails(true)}>
              {tx("work.meetingview.doi_gio_dia_diem")}
            </button>
          ) : null}
          {m.actionItems.length ? <p className="text-ink-2 text-xs">{tx("work.meetingview.viec_sau_hop_xuat")}</p> : null}
        </aside>
        {details ? (
          <DetailsModal
            m={m}
            onClose={() => setDetails(false)}
            onSave={async (b) => {
              if (await patch(b, tx("work.meetingview.da_cap_nhat_va"))) {
                setDetails(false);
                router.refresh();
              }
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

function DetailsModal({ m, onClose, onSave }: { m: MeetingDetail; onClose: () => void; onSave: (b: Record<string, unknown>) => void }) {
  const tx = useT();
  const dir = useDirectory();
  // Times in the workspace's zone, as the calendar draws them (not the browser's own zone).
  const [title, setTitle] = useState(m.event.title);
  const [start, setStart] = useState(zonedInput(m.event.startsAt));
  const [end, setEnd] = useState(zonedInput(m.event.endsAt));
  const [location, setLocation] = useState(m.event.location);
  const [people, setPeople] = useState(m.attendees.map((a) => a.userId).filter((u) => u !== m.event.organizerId));
  const bad = fromZonedInput(end) <= fromZonedInput(start);
  return (
    <Modal
      title={tx("work.meetingview.sua_cuoc_hop")}
      wide
      onClose={onClose}
      footer={
        <>
          <button type="button" className={btn} onClick={onClose}>
            {tx("work.meetingview.huy")}
          </button>
          <button
            type="button"
            className={btnPrimary}
            disabled={!title.trim() || bad}
            onClick={() => onSave({ title, startsAt: fromZonedInput(start).toISOString(), endsAt: fromZonedInput(end).toISOString(), location, attendeeIds: people })}
          >
            {tx("work.meetingview.luu_va_bao_moi")}
          </button>
        </>
      }
    >
      <div className="grid gap-4 md:grid-cols-2">
        <div className="grid content-start gap-4">
          <Field label={tx("work.meetingview.tieu_de")}>
            <input className={input} value={title} onChange={(x) => setTitle(x.target.value)} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <FormField label={tx("work.meetingview.bat_dau")}>
              <DateField withTime clearable={false} label={tx("work.meetingview.bat_dau")} value={start} onChange={setStart} />
            </FormField>
            <FormField label={tx("work.meetingview.ket_thuc")} error={bad ? tx("work.meetingview.phai_sau_gio_bat") : null}>
              <DateField withTime clearable={false} label={tx("work.meetingview.ket_thuc")} value={end} onChange={setEnd} />
            </FormField>
          </div>
          <Field label={tx("work.meetingview.dia_diem_hoac_link")}>
            <input className={input} value={location} onChange={(x) => setLocation(x.target.value)} />
          </Field>
        </div>
        <Field label={tx("work.meetingview.nguoi_tham_gia")}>
          <PeoplePicker selected={people} onChange={setPeople} exclude={[dir.me]} />
        </Field>
      </div>
    </Modal>
  );
}
