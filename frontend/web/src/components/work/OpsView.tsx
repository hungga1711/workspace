"use client";

import { numberFormat } from "@/lib/intl";
import { PersonChip } from "@/components/chat/PersonTrigger";
import { useFeature } from "@/lib/features-context";
import { INTL_TAG, type Locale } from "@/lib/i18n/config";
import Link from "next/link";
import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import { useFormat, useLocale, useT } from "@/lib/i18n/client";
import type { MessageKey, T } from "@/lib/i18n/core";
import { Avatar, useDirectory } from "@/lib/people";
import { btn, btnGhost, btnPrimary, btnSm, cx, hitPad, input, textarea } from "@/lib/ui";
import { Menu } from "@/components/ui/Menu";
import { useToast } from "@/components/ui/Toast";
import { Picker } from "@/components/ui/Picker";
import { Checkbox } from "@/components/ui/Checkbox";
import { Tabs } from "@/components/ui/Tabs";
import { PageHeader } from "@/components/ui/PageHeader";
import { SearchToggle } from "./ToolbarPopover";
import { Modal } from "@/components/ui/Modal";
import { ReasonDialog } from "@/components/ui/ReasonDialog";
import { Field, StatusPill } from "@/components/ui/bits";
import { SlimEmpty, StatStrip } from "./progressUi";
import { PeoplePicker } from "@/components/chat/NewConversation";
import { ApprovalIcon, CashIcon, CheckIcon, ClockIcon, CloseIcon, DownloadIcon, MoreIcon, PlusIcon, SettingsIcon } from "@/components/app/icons";
import { KindIcon, KindTile } from "./kindIcon";
import { downloadCsv } from "@/lib/downloadCsv";
import { CURRENCIES, formatMoney } from "@/lib/money";
import type { Approval } from "./types";
import { approvalHref } from "@/lib/links";

/** The message for a key built at run time, or `fallback` when there is none (a leave type the company added, say). */
const tKnown = (t: T, key: string, fallback: string) => {
  const v = t(key as MessageKey);
  return v === key ? fallback : v;
};

/** The header's total in words ("196 triệu ₫", "$12,400"), so it reads as a sentence; rows keep the short form ("165 tr"). */
const longAmount = (n: number, currency: string, locale: Locale) =>
  currency === "VND"
    ? `${numberFormat(INTL_TAG[locale], { notation: "compact", compactDisplay: "long", maximumSignificantDigits: 3 }).format(n)} ₫`
    : formatMoney(n, currency, locale).full;

export interface LeaveItem {
  id: string;
  userId: string;
  type: string;
  startDate: string;
  endDate: string;
  days: number;
  status: string;
  reason: string;
  createdAt: string;
  approverId?: string;
  decidedAt?: string | null;
}
export interface RequestTemplate {
  id: string;
  name: string;
  icon: string;
  description: string;
  fields: { label: string; type: "text" | "textarea" | "date" | "number" }[];
  money: boolean;
  approverId: string | null;
}
type Kind = "purchase" | "payment" | "advance" | "trip" | "leave" | "other";
const KINDS: Kind[] = ["purchase", "payment", "advance", "trip", "leave", "other"];
interface Item {
  icon?: string;
  key: string;
  source: "approval" | "leave";
  id: string;
  /** A request's code (YC-007); leave has none. */
  code?: string | null;
  kind: Kind;
  title: string;
  details: string;
  amount: number | null;
  currency: string | null;
  personId: string;
  createdAt: string;
  status: string;
  decidedAt: string | null;
  href: string | null;
  /** Leave: its first day, to flag a request still waiting after the leave has begun. */
  startsOn?: string;
}
type View = "inbox" | "mine" | "done";
const waited = (iso: string) => Math.floor((Date.now() - Date.parse(iso)) / 86400_000);
/** How long a decision can be taken back before it is sent. */
const UNDO_MS = 10_000;

/**
 * Work › Vận hành: every request that needs someone's decision, in one queue. Approvals (purchases,
 * payments, advances, business trips, other) and my team's leave requests wait here together, with the
 * money involved and how long each has waited; requests start from a template so they arrive complete.
 */
export function OpsView({
  incoming,
  outgoing,
  leaveIn,
  leaveMine,
  managerId,
  openNew,
  templates = [],
  canManageTemplates = false,
  defaultCurrency = "VND",
}: {
  incoming: Approval[];
  outgoing: Approval[];
  leaveIn: LeaveItem[];
  leaveMine: LeaveItem[];
  managerId: string | null;
  openNew?: boolean;
  templates?: RequestTemplate[];
  canManageTemplates?: boolean;
  /** The workspace's currency (Admin › Settings), preselected in the request form. */
  defaultCurrency?: string;
}) {
  const [managing, setManaging] = useState(false);
  // A leave request opens in a dialog like an approval does (it has no page of its own).
  const [leaveOpen, setLeaveOpen] = useState<{ x: Item; view: View } | null>(null);
  const t = useT();
  const { ago, shortDate } = useFormat();
  const dir = useDirectory();
  const router = useRouter();
  const leaveTitle = (l: LeaveItem) => `${tKnown(t, `ops.leave_${l.type}`, l.type)} · ${t("ops.days", { count: l.days })}`;
  const fromApproval = (a: Approval, person: string): Item => ({
    key: `a:${a.id}`,
    source: "approval",
    id: a.id,
    code: a.code ?? null,
    kind: (a.kind ?? "other") as Kind,
    icon: templates.find((x) => x.id === a.templateId)?.icon,
    title: a.title,
    details: [
      Object.values(a.fields ?? {})
        .filter(Boolean)
        .join(" · "),
      a.details,
    ]
      .filter(Boolean)
      .join(" · "),
    amount: a.amount ?? null,
    currency: a.currency ?? null,
    personId: person,
    createdAt: a.createdAt,
    status: a.status,
    decidedAt: a.decidedAt,
    href: approvalHref(a),
  });
  const fromLeave = (l: LeaveItem): Item => ({
    key: `l:${l.id}`,
    source: "leave",
    id: l.id,
    kind: "leave",
    title: leaveTitle(l),
    details: [`${shortDate(l.startDate)} – ${shortDate(l.endDate)}`, l.reason].filter(Boolean).join(" · "),
    amount: null,
    currency: null,
    personId: l.userId,
    createdAt: l.createdAt,
    status: l.status,
    decidedAt: l.decidedAt ?? null,
    href: null,
    startsOn: l.startDate,
  });
  // Seeded from the server on first render (so the default view is right), refreshed after router.refresh.
  const build = () => [...incoming.map((a) => fromApproval(a, a.requesterId)), ...leaveIn.map(fromLeave)];
  const [inbox, setInbox] = useState<Item[]>(build);
  useEffect(() => setInbox(build()), [incoming, leaveIn]); // eslint-disable-line react-hooks/exhaustive-deps
  const mine = [...outgoing.map((a) => fromApproval(a, a.approverId)), ...leaveMine.map((l) => ({ ...fromLeave(l), personId: l.approverId ?? l.userId }))].sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
  );
  const pending = inbox.filter((x) => x.status === "pending").sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const done = inbox.filter((x) => x.status !== "pending").sort((a, b) => Date.parse(b.decidedAt ?? b.createdAt) - Date.parse(a.decidedAt ?? a.createdAt));
  const [view, setView] = useState<View>(pending.length || !mine.length ? "inbox" : "mine");
  // A #view in the URL (a shared link, or Back after switching tabs) picks the view.
  useEffect(() => {
    const fromHash = () => {
      const h = window.location.hash.slice(1);
      if (h === "inbox" || h === "mine" || h === "done") setView(h);
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, []);
  const [kind, setKind] = useState<Kind | "">("");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(!!openNew);
  const toast = useToast();
  const base = view === "inbox" ? pending : view === "mine" ? mine : done;
  const list = base.filter((x) => (!kind || x.kind === kind) && (!q || `${x.code ?? ""} ${x.title} ${x.details} ${dir.name(x.personId)}`.toLowerCase().includes(q.toLowerCase())));
  const locale = useLocale();
  const money = (n: number, currency: string | null) => formatMoney(n, currency ?? "VND", locale).full;
  // One total per currency: mixing them in one number would mislead.
  const totals = [...pending.reduce((m, x) => (x.amount ? m.set(x.currency ?? "VND", (m.get(x.currency ?? "VND") ?? 0) + x.amount) : m), new Map<string, number>())];
  const oldest = pending.length ? waited(pending[0]!.createdAt) : 0;

  // A decision waits UNDO_MS before it is sent, with "Undo" on its toast (a mis-tap on Approve is common on a long
  // queue); leaving the page sends whatever is still waiting.
  const waiting = useRef(new Map<string, { x: Item; decision: "approved" | "rejected"; note?: string; timer: ReturnType<typeof setTimeout> }>());
  const commit = async (x: Item, decision: "approved" | "rejected", note?: string) => {
    try {
      await api(x.source === "approval" ? `work/approvals/${x.id}/decision` : `employee/leave/${x.id}/decision`, {
        method: "POST",
        body: x.source === "approval" ? { decision, comment: note ?? null } : { decision, ...(note ? { note } : {}) },
      });
      router.refresh(); // the count in the tab bar
    } catch {
      setInbox((l) => l.map((y) => (y.key === x.key ? x : y)));
      setError(t("ops.decideFailed", { title: x.title }));
    }
  };
  useEffect(() => {
    const map = waiting.current;
    return () => {
      for (const w of map.values()) {
        clearTimeout(w.timer);
        void commit(w.x, w.decision, w.note);
      }
      map.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- flush once, on leaving the page
  }, []);
  const decide = (x: Item, decision: "approved" | "rejected", quiet = false, note?: string) => {
    setError(null);
    setInbox((l) => l.map((y) => (y.key === x.key ? { ...y, status: decision, decidedAt: new Date().toISOString() } : y)));
    setSel((s) => new Set([...s].filter((k) => k !== x.key)));
    if (quiet) return void commit(x, decision, note);
    const timer = setTimeout(() => {
      waiting.current.delete(x.key);
      void commit(x, decision, note);
    }, UNDO_MS);
    waiting.current.set(x.key, { x, decision, note, timer });
    toast({
      message: t(decision === "approved" ? "ops.approvedToast" : "ops.rejectedToast", { title: x.title }),
      duration: UNDO_MS,
      undo: () => {
        clearTimeout(timer);
        waiting.current.delete(x.key);
        setInbox((l) => l.map((y) => (y.key === x.key ? x : y)));
      },
    });
  };
  // Refusing asks why first (ReasonDialog); the reason travels with the decision.
  const [refusing, setRefusing] = useState<Item | null>(null);
  const reject = (x: Item) => setRefusing(x);
  const kinds = (["", ...KINDS] as const).map((k) => ({ k, n: base.filter((x) => !k || x.kind === k).length })).filter(({ k, n }) => !k || n > 0);
  const exportCsv = () =>
    downloadCsv(`${t("ops.csvFile")}-${view}-${new Date().toISOString().slice(0, 10)}.csv`, [
      [t("ops.csvCode"), t("ops.csvType"), t("ops.csvTitle"), t("ops.csvPerson"), t("ops.csvSent"), t("ops.amount"), t("ops.currency"), t("ops.csvStatus"), t("ops.csvDetails")],
      ...list.map((x) => [
        x.code ?? "",
        t(`ops.kind_${x.kind}`),
        x.title,
        dir.name(x.personId),
        shortDate(x.createdAt),
        x.amount ?? "",
        x.amount ? (x.currency ?? "VND") : "",
        x.status,
        x.details,
      ]),
    ]);
  // The queue at a glance (Home's strip): how many wait, how much money they ask for, how long the oldest has waited.
  const summary =
    view === "inbox" && pending.length ? (
      <StatStrip
        label={t("ops.statLabel")}
        className="mb-4"
        items={[
          { label: t("ops.statWaiting"), value: pending.length, icon: <ApprovalIcon />, tone: "violet" },
          ...(totals.length
            ? [
                {
                  label: t("ops.statAmount"),
                  value: totals.map(([cur, n]) => formatMoney(n, cur, locale).short).join(" + "),
                  title: t("ops.total", { amount: totals.map(([cur, n]) => longAmount(n, cur, locale)).join(" + ") }),
                  icon: <CashIcon />,
                  tone: "green" as const,
                },
              ]
            : []),
          {
            label: t("ops.statOldest"),
            value: oldest,
            icon: <ClockIcon />,
            tone: "tangerine",
            quiet: oldest < 1,
            title: oldest >= 1 ? t("ops.oldest", { count: oldest }) : undefined,
          },
        ]}
      />
    ) : null;
  const filters = (
    <>
      <SearchToggle value={q} onChange={setQ} label={t("ops.search")} />
      {kinds.length > 1 ? (
        <Picker
          variant="button"
          align="right"
          label={t("ops.kinds")}
          prefix={t("ops.kindShort")}
          value={kind}
          onChange={(v) => setKind(v as Kind | "")}
          options={kinds.map(({ k, n }) => ({
            value: k,
            label: k ? `${t(`ops.kind_${k}`)} · ${n}` : t("ops.all"),
            icon: k ? <KindIcon kind={k} /> : undefined,
          }))}
        />
      ) : null}
    </>
  );
  return (
    <>
      <PageHeader
        title={t("ops.title")}
        actions={
          <>
            {list.length || canManageTemplates ? (
              <Menu
                label={t("ops.more")}
                items={[
                  ...(list.length ? [{ label: t("ops.export"), icon: <DownloadIcon />, onSelect: exportCsv }] : []),
                  ...(canManageTemplates ? [{ label: t("ops.templates"), icon: <SettingsIcon />, onSelect: () => setManaging(true) }] : []),
                ]}
                trigger={
                  <span className={cx(btn, "h-9 min-h-0 w-9 px-0")}>
                    <MoreIcon className="size-4" />
                  </span>
                }
              />
            ) : null}
            <button type="button" className={btnPrimary} onClick={() => setCreating(true)}>
              <PlusIcon className="size-4" />
              {t("ops.new")}
            </button>
          </>
        }
        tabs={
          // The count shows once, on its tab. Views are #hash links: shareable, no server round trip.
          <Tabs
            label={t("ops.views")}
            active={view}
            onSelect={(k) => {
              setView(k as View);
              setSel(new Set());
            }}
            tabs={[
              { key: "inbox", label: t("ops.inbox"), href: "/app/work/ops#inbox", count: pending.length },
              { key: "mine", label: t("ops.mineTab"), href: "/app/work/ops#mine" },
              { key: "done", label: t("ops.done"), href: "/app/work/ops#done" },
            ]}
          />
        }
        toolbar={<div className="flex items-center gap-2 max-sm:hidden">{filters}</div>}
      />
      {/* Phones: the filters get their own row under the tabs; the summary sits under them on one line of its own, so it
          never wraps into a narrow column beside the controls. */}
      <div className="mb-3 flex items-center gap-2 sm:hidden">{filters}</div>
      {summary}
      {error ? (
        <p className="text-block mb-2 text-sm" role="alert">
          {error}
        </p>
      ) : null}
      {view === "inbox" && sel.size ? (
        <div className="bg-ink text-surface shadow-lift mb-2 flex flex-wrap items-center gap-2 rounded-xl px-3 py-2 text-sm">
          <span className="font-medium">{t("ops.selected", { count: sel.size })}</span>
          <button type="button" className={cx(btn, btnSm, "ml-auto")} onClick={() => pending.filter((x) => sel.has(x.key)).forEach((x) => decide(x, "approved", true))}>
            {t("ops.approveSelected")}
          </button>
          <button type="button" className={cx(btnGhost, btnSm, "text-surface hover:bg-surface/10")} onClick={() => setSel(new Set())}>
            {t("common.cancel")}
          </button>
        </div>
      ) : null}
      {list.length === 0 ? (
        <SlimEmpty
          icon={view === "inbox" ? undefined : <ApprovalIcon />}
          tone={view === "inbox" ? "green" : "violet"}
          title={view === "inbox" ? t("ops.emptyInbox") : view === "mine" ? t("ops.emptyMine") : t("ops.emptyDone")}
        >
          {view === "mine" ? t("ops.emptyMineHint") : undefined}
        </SlimEmpty>
      ) : (
        <ul
          aria-label={view === "inbox" ? t("ops.inbox") : view === "mine" ? t("ops.mine") : t("ops.done")}
          className="divide-divider-soft bg-surface shadow-card m-0 list-none divide-y overflow-hidden rounded-xl p-0"
        >
          {/* A decided request slides out and the queue closes up (Motion). */}
          <AnimatePresence initial={false} mode="popLayout">
            {list.map((x) => {
              const w = waited(x.createdAt);
              return (
                <m.li
                  key={x.key}
                  layout="position"
                  exit={{ opacity: 0, x: 32, transition: { duration: 0.18, ease: "easeIn" } }}
                  className={cx(
                    "flex min-h-14 items-center gap-x-3 gap-y-1.5 px-3 py-2.5 transition-colors sm:px-4",
                    (x.href || x.source === "leave") && "hover:bg-hover relative",
                  )}
                >
                  {view === "inbox" ? (
                    <Checkbox
                      className="relative z-10"
                      checked={sel.has(x.key)}
                      onChange={() => setSel((s) => (s.has(x.key) ? new Set([...s].filter((k) => k !== x.key)) : new Set([...s, x.key])))}
                      aria-label={t("ops.pick", { title: x.title })}
                    />
                  ) : null}
                  <span className="max-sm:hidden">
                    <KindTile kind={x.kind} emoji={x.icon} />
                  </span>
                  <span className="min-w-0 flex-1 sm:basis-48">
                    {x.href ? (
                      <Link
                        href={x.href}
                        // The link covers the row (so a handled request still reads as clickable); the row's buttons sit above it.
                        className={cx(
                          "text-ink font-medium no-underline before:absolute before:inset-0 before:content-[''] max-sm:line-clamp-2 sm:block sm:truncate md:-my-0.5 md:py-0.5",
                          hitPad,
                        )}
                        title={x.title}
                      >
                        {x.title}
                      </Link>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setLeaveOpen({ x, view })}
                        className={cx(
                          "text-ink block w-full text-left font-medium before:absolute before:inset-0 before:content-[''] max-sm:line-clamp-2 sm:truncate md:-my-0.5 md:py-0.5",
                          hitPad,
                        )}
                        title={x.title}
                      >
                        {x.title}
                      </button>
                    )}
                    <span className="text-ink-2 flex min-w-0 items-center gap-1.5 text-xs">
                      <Avatar id={x.personId} size="xs" />
                      <span className="truncate sm:shrink-0">
                        {x.code ? <span className="font-mono tracking-tight max-sm:hidden">{x.code} · </span> : null}
                        {x.amount ? <b className="text-ink font-medium tabular-nums sm:hidden">{money(x.amount, x.currency)} · </b> : null}
                        {view === "mine" ? t("ops.to", { name: dir.name(x.personId) }) : dir.name(x.personId)} · {ago(x.createdAt)}
                      </span>
                      {/* The details are a hint, not the story: a short tail that gives way first. */}
                      {x.details ? (
                        <span className="min-w-0 max-w-[44ch] truncate max-lg:hidden" title={x.details}>
                          · {x.details}
                        </span>
                      ) : null}
                    </span>
                  </span>
                  {x.amount ? <span className="shrink-0 text-sm font-medium tabular-nums max-sm:hidden">{money(x.amount, x.currency)}</span> : null}
                  {view === "inbox" ? (
                    <>
                      {x.startsOn && x.startsOn <= new Date().toISOString().slice(0, 10) ? (
                        <span className="bg-block-wash text-block shrink-0 rounded px-1.5 py-0.5 text-xs font-medium">{t("ops.overdueLeave")}</span>
                      ) : null}
                      {w >= 1 ? (
                        <span className="text-ink-soft inline-flex shrink-0 items-center gap-1.5 text-xs max-md:hidden">
                          <span aria-hidden="true" className={cx("size-1.5 rounded-full", w >= 3 ? "bg-block" : "bg-warn")} />
                          {t("ops.waited", { count: w })}
                        </span>
                      ) : null}
                      <span className="relative z-10 hidden shrink-0 gap-1 sm:flex">
                        <button type="button" className={cx(btn, btnSm)} onClick={() => decide(x, "approved")}>
                          <CheckIcon className="size-4" />
                          {t("ops.approve")}
                        </button>
                        <button type="button" className={cx(btnGhost, btnSm, "text-ink-2")} onClick={() => reject(x)}>
                          {t("ops.reject")}
                        </button>
                      </span>
                      <span className="relative z-10 sm:hidden">
                        <Menu
                          label={t("ops.rowActions", { title: x.title })}
                          items={[
                            { label: t("ops.approve"), icon: <CheckIcon />, onSelect: () => decide(x, "approved") },
                            { label: t("ops.reject"), icon: <CloseIcon />, onSelect: () => reject(x) },
                          ]}
                          trigger={
                            <span className="text-ink-2 hover:bg-hover grid size-9 place-items-center rounded-md">
                              <MoreIcon className="size-4" />
                            </span>
                          }
                        />
                      </span>
                    </>
                  ) : (
                    <span className="flex shrink-0 items-center gap-2">
                      {x.decidedAt ? <span className="text-ink-2 text-xs">{ago(x.decidedAt)}</span> : null}
                      <StatusPill status={x.status} />
                    </span>
                  )}
                </m.li>
              );
            })}
          </AnimatePresence>
        </ul>
      )}
      {managing ? <TemplatesModal templates={templates} onClose={() => setManaging(false)} /> : null}
      {refusing ? (
        <ReasonDialog
          title={t(refusing.source === "approval" ? "ui.reason.title" : "ui.reason.leaveTitle")}
          subject={`${refusing.code ? `${refusing.code} · ` : ""}${refusing.title} · ${dir.name(refusing.personId)}`}
          onClose={() => setRefusing(null)}
          onConfirm={(reason) => {
            decide(refusing, "rejected", false, reason);
            setRefusing(null);
          }}
        />
      ) : null}
      {leaveOpen ? (
        <Modal
          title={t("ops.kind_leave")}
          onClose={() => setLeaveOpen(null)}
          footer={
            leaveOpen.view === "inbox" && leaveOpen.x.status === "pending" ? (
              <>
                <button
                  type="button"
                  className={btn}
                  onClick={() => {
                    reject(leaveOpen.x);
                    setLeaveOpen(null);
                  }}
                >
                  {t("ops.reject")}
                </button>
                <button
                  type="button"
                  className={btnPrimary}
                  onClick={() => {
                    decide(leaveOpen.x, "approved");
                    setLeaveOpen(null);
                  }}
                >
                  <CheckIcon className="size-4" />
                  {t("ops.approve")}
                </button>
              </>
            ) : (
              <button type="button" className={btn} onClick={() => setLeaveOpen(null)}>
                {t("common.close")}
              </button>
            )
          }
        >
          <div className="grid gap-4">
            <div className="flex items-center gap-3">
              <KindTile kind="leave" />
              <div className="min-w-0 flex-1">
                <p className="text-ink m-0 text-base font-semibold">{leaveOpen.x.title}</p>
                <p className="text-ink-2 m-0 text-sm">{leaveOpen.x.details}</p>
              </div>
              <StatusPill status={leaveOpen.x.status} />
            </div>
            <dl className="border-hairline m-0 grid gap-2 border-t pt-4 text-sm">
              <div className="flex items-center justify-between gap-3">
                <dt className="text-ink-2">{leaveOpen.view === "mine" ? t("ops.approver") : t("ops.requester")}</dt>
                <dd className="m-0 flex min-w-0">
                  <PersonChip userId={leaveOpen.x.personId} />
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-ink-2">{t("ops.sent")}</dt>
                <dd className="m-0">{ago(leaveOpen.x.createdAt)}</dd>
              </div>
              {leaveOpen.x.decidedAt ? (
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-ink-2">{t("ops.decided")}</dt>
                  <dd className="m-0">{ago(leaveOpen.x.decidedAt)}</dd>
                </div>
              ) : null}
            </dl>
          </div>
        </Modal>
      ) : null}
      {creating ? (
        <NewRequestModal
          templates={templates}
          managerId={managerId}
          defaultCurrency={defaultCurrency}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            setView("mine");
            router.refresh();
          }}
        />
      ) : null}
    </>
  );
}

type Template = Exclude<Kind, "leave">;
/** Each template asks for what the approver needs to decide; the title is built from them when left empty. */
const FIELDS: Record<Template, { key: string; type?: "date" | "textarea" }[]> = {
  purchase: [{ key: "item" }, { key: "vendor" }, { key: "reason", type: "textarea" }],
  payment: [{ key: "payee" }, { key: "dueDate", type: "date" }, { key: "reason", type: "textarea" }],
  advance: [{ key: "purpose" }, { key: "repayBy", type: "date" }],
  trip: [{ key: "destination" }, { key: "from", type: "date" }, { key: "to", type: "date" }, { key: "purpose", type: "textarea" }],
  other: [{ key: "reason", type: "textarea" }],
};
const MONEY: Record<Template, boolean> = { purchase: true, payment: true, advance: true, trip: true, other: false };

function NewRequestModal({
  templates,
  managerId,
  defaultCurrency,
  onClose,
  onCreated,
}: {
  templates: RequestTemplate[];
  managerId: string | null;
  defaultCurrency: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const t = useT();
  // Leave belongs to Chấm công: not offered on an installation without it (left out at deploy time).
  const hasTime = useFeature("time");
  const locale = useLocale();
  const dir = useDirectory();
  const [kind, setKindRaw] = useState<Template | null>(null);
  const [custom, setCustom] = useState<RequestTemplate | null>(null);
  const setKind = (k: Template | null) => {
    setKindRaw(k);
    if (!k) setCustom(null);
  };
  const [title, setTitle] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState(defaultCurrency);
  const [approver, setApprover] = useState<string[]>(managerId ? [managerId] : []);
  const [error, setError] = useState<string | null>(null);
  const [amountError, setAmountError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const label = (k: string) => (custom ? k : tKnown(t, `ops.f_${k}`, k));
  const fieldList: { key: string; type?: "date" | "textarea" | "number" | "text" }[] = custom
    ? custom.fields.map((f) => ({ key: f.label, type: f.type }))
    : kind
      ? FIELDS[kind]
      : [];
  const kindName = custom ? custom.name : kind ? t(`ops.kind_${kind}`) : "";
  const submit = async () => {
    if (!kind) return;
    const main = fields[fieldList[0]!.key]?.trim();
    const name = title.trim() || (main ? `${kindName}: ${main}` : "");
    setError(null);
    setAmountError(null);
    if (!name || !approver[0]) {
      setError(t("ops.needTitle"));
      return;
    }
    // Purchases, payments and advances are decided on their amount (the server refuses them without one); the
    // message sits under the Amount field, where the fix is.
    if ((kind === "purchase" || kind === "payment" || kind === "advance") && !(Number(amount) > 0)) {
      setAmountError(t("ops.needAmount"));
      return;
    }
    setBusy(true);
    try {
      const shown = Object.fromEntries(
        Object.entries(fields)
          .filter(([, v]) => v.trim())
          .map(([k, v]) => [label(k), v.trim()]),
      );
      await api("work/approvals", {
        method: "POST",
        body: {
          title: name,
          details: "",
          approverId: approver[0],
          kind,
          templateId: custom?.id ?? null,
          amount: amount ? Number(amount) : null,
          currency: amount ? currency : null,
          fields: shown,
        },
      });
      onCreated();
    } catch {
      setError(t("ops.sendFailed"));
      setBusy(false);
    }
  };
  return (
    <Modal
      title={kind ? kindName : t("ops.new")}
      onClose={onClose}
      wide
      footer={
        kind ? (
          <>
            <button type="button" className={cx(btn, "mr-auto")} onClick={() => setKind(null)}>
              {t("ops.back")}
            </button>
            <button type="button" className={btn} onClick={onClose}>
              {t("common.cancel")}
            </button>
            <button type="button" className={btnPrimary} disabled={busy} onClick={() => void submit()}>
              {t("ops.send")}
            </button>
          </>
        ) : undefined
      }
    >
      {!kind ? (
        <div className="grid gap-3">
          <p className="text-ink-2 m-0 text-sm">{t("ops.pickTemplate")}</p>
          <ul className="m-0 grid list-none grid-cols-2 gap-2 p-0 sm:grid-cols-3">
            {(["purchase", "payment", "advance", "trip", "other"] as const).map((k) => (
              <li key={k}>
                <button
                  type="button"
                  onClick={() => setKind(k)}
                  className="border-hairline hover:bg-hover grid h-full w-full justify-items-start gap-1 rounded-lg border p-3 text-left"
                >
                  <KindTile kind={k} />
                  <span className="text-sm font-semibold">{t(`ops.kind_${k}`)}</span>
                  <span className="text-ink-2 text-xs">{t(`ops.hint_${k}`)}</span>
                </button>
              </li>
            ))}
            {templates.map((tpl) => (
              <li key={tpl.id}>
                <button
                  type="button"
                  onClick={() => {
                    setKindRaw("other");
                    setCustom(tpl);
                    if (tpl.approverId) setApprover([tpl.approverId]);
                  }}
                  className="border-hairline hover:bg-hover grid h-full w-full justify-items-start gap-1 rounded-lg border p-3 text-left"
                >
                  <KindTile kind="other" emoji={tpl.icon} />
                  <span className="text-sm font-semibold">{tpl.name}</span>
                  <span className="text-ink-2 text-xs">{tpl.description || t("ops.companyTemplate")}</span>
                </button>
              </li>
            ))}
            {hasTime ? (
              <li>
                <Link
                  href="/app/time?tab=leave&new=leave"
                  className="border-hairline hover:bg-hover text-ink grid h-full w-full justify-items-start gap-1 rounded-lg border p-3 no-underline"
                >
                  <KindTile kind="leave" />
                  <span className="text-sm font-semibold">{t("ops.kind_leave")}</span>
                  <span className="text-ink-2 text-xs">{t("ops.hint_leave")}</span>
                </Link>
              </li>
            ) : null}
          </ul>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {fieldList.map((f) => (
            <div key={f.key} className={cx(f.type === "textarea" && "sm:col-span-2")}>
              <Field label={label(f.key)}>
                {f.type === "textarea" ? (
                  <textarea className={cx(textarea, "min-h-20")} value={fields[f.key] ?? ""} onChange={(e) => setFields({ ...fields, [f.key]: e.target.value })} />
                ) : (
                  <input
                    className={input}
                    type={f.type === "number" ? "text" : (f.type ?? "text")}
                    inputMode={f.type === "number" ? "numeric" : undefined}
                    value={fields[f.key] ?? ""}
                    onChange={(e) => setFields({ ...fields, [f.key]: e.target.value })}
                  />
                )}
              </Field>
            </div>
          ))}
          {(custom ? custom.money : MONEY[kind]) ? (
            <div className="grid grid-cols-[minmax(0,1fr)_132px] gap-2">
              <Field label={t("ops.amount")} hint={amount ? formatMoney(Number(amount), currency, locale).full : undefined} error={amountError}>
                <input
                  className={cx(input, "font-mono")}
                  inputMode={currency === "VND" ? "numeric" : "decimal"}
                  value={amount}
                  // VND has no minor unit; other currencies take up to two decimals.
                  onChange={(e) => {
                    setAmountError(null);
                    setAmount((currency === "VND" ? e.target.value.replace(/\D/g, "") : e.target.value.replace(/[^\d.]/g, "").replace(/^(\d*\.\d{0,2}).*$/, "$1")).slice(0, 14));
                  }}
                  placeholder="0"
                />
              </Field>
              <Field label={t("ops.currency")}>
                <Picker
                  variant="field"
                  label={t("ops.currency")}
                  value={currency}
                  onChange={(v) => {
                    setCurrency(v);
                    if (v === "VND") setAmount((a) => a.replace(/\..*$/, ""));
                  }}
                  options={[...new Set([defaultCurrency, ...CURRENCIES])].map((c) => ({ value: c, label: c }))}
                />
              </Field>
            </div>
          ) : null}
          <div className="sm:col-span-2">
            <Field label={t("ops.titleField")} hint={t("ops.titleHint")} error={error}>
              <input className={input} value={title} onChange={(e) => setTitle(e.target.value)} />
            </Field>
          </div>
          <div className="sm:col-span-2">
            <Field label={t("ops.approver")} hint={managerId && approver[0] === managerId ? t("ops.approverManager") : undefined}>
              <PeoplePicker single selected={approver} onChange={setApprover} exclude={[dir.me]} />
            </Field>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** Vận hành › Mẫu yêu cầu (admins): the company's own request types, each with its fields and default approver. */
function TemplatesModal({ templates, onClose }: { templates: RequestTemplate[]; onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const failed = () => toast({ message: t("common.actionFailed") });
  const router = useRouter();
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("📝");
  const [description, setDescription] = useState("");
  const [fields, setFields] = useState<{ label: string; type: RequestTemplate["fields"][number]["type"] }[]>([{ label: "", type: "text" }]);
  const [money, setMoney] = useState(false);
  const [approver, setApprover] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    const list = fields.filter((f) => f.label.trim());
    if (!name.trim() || !list.length) {
      setError(t("ops.tplNeed"));
      return;
    }
    try {
      await api("work/request-templates", { method: "POST", body: { name, icon: icon || "📝", description, fields: list, money, approverId: approver[0] ?? null } });
      setName("");
      setDescription("");
      setFields([{ label: "", type: "text" }]);
      setMoney(false);
      setApprover([]);
      setError(null);
      router.refresh();
    } catch {
      setError(t("ops.tplFailed"));
    }
  };
  return (
    <Modal title={t("ops.templates")} onClose={onClose} wide>
      <div className="grid gap-5">
        {templates.length ? (
          <ul className="border-hairline divide-hairline m-0 list-none divide-y rounded-lg border p-0">
            {templates.map((x) => (
              <li key={x.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <span aria-hidden="true">{x.icon}</span>
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{x.name}</span>
                  <span className="text-ink-2 block truncate text-xs">{x.fields.map((f) => f.label).join(" · ")}</span>
                </span>
                <button
                  type="button"
                  className={cx(btn, btnSm)}
                  onClick={() =>
                    void api(`work/request-templates/${x.id}`, { method: "DELETE" })
                      .then(() => router.refresh())
                      .catch(failed)
                  }
                >
                  {t("ops.tplRemove")}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-ink-2 m-0 text-sm">{t("ops.tplNone")}</p>
        )}
        <section aria-label={t("ops.tplNew")} className="grid gap-3">
          <h3 className="m-0 text-sm font-semibold">{t("ops.tplNew")}</h3>
          <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-3">
            <Field label={t("ops.tplIcon")}>
              <input className={input} value={icon} maxLength={8} onChange={(e) => setIcon(e.target.value)} />
            </Field>
            <Field label={t("ops.tplName")} error={error}>
              <input className={input} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("ops.tplNamePh")} />
            </Field>
          </div>
          <Field label={t("ops.tplDescription")}>
            <input className={input} value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <div className="grid gap-2">
            <span className="text-sm font-medium">{t("ops.tplFields")}</span>
            {fields.map((f, i) => (
              <div key={i} className="flex gap-2">
                <input
                  className={cx(input, "min-w-0 flex-1")}
                  aria-label={t("ops.tplFieldLabel", { n: i + 1 })}
                  value={f.label}
                  onChange={(e) => setFields(fields.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                />
                <Picker
                  variant="button"
                  align="right"
                  className="w-36 [&>button]:w-full [&>button]:justify-between"
                  label={t("ops.tplFieldType", { n: i + 1 })}
                  value={f.type}
                  onChange={(v) => setFields(fields.map((x, j) => (j === i ? { ...x, type: v as typeof f.type } : x)))}
                  options={(["text", "textarea", "date", "number"] as const).map((k) => ({ value: k, label: t(`ops.ft_${k}`) }))}
                />
              </div>
            ))}
            {fields.length < 10 ? (
              <button type="button" className={cx(btn, btnSm, "justify-self-start")} onClick={() => setFields([...fields, { label: "", type: "text" }])}>
                {t("ops.tplAddField")}
              </button>
            ) : null}
          </div>
          <Checkbox label={t("ops.tplMoney")} checked={money} onChange={(e) => setMoney(e.target.checked)} />
          <Field label={t("ops.tplApprover")}>
            <PeoplePicker single selected={approver} onChange={setApprover} />
          </Field>
          <button type="button" className={cx(btnPrimary, "justify-self-start")} onClick={() => void save()}>
            {t("ops.tplCreate")}
          </button>
        </section>
      </div>
    </Modal>
  );
}
