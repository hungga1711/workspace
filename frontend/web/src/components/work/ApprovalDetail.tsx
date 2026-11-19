"use client";

import { PersonChip, PersonTrigger } from "@/components/chat/PersonTrigger";
import { ActivityRow, activityList } from "@/components/comments/ActivityRow";
import { CommentBody } from "@/components/comments/CommentBody";
import { CommentComposer } from "@/components/comments/CommentComposer";
import { CommentEntry } from "@/components/comments/CommentEntry";
import { useT, useFormat, useLocale } from "@/lib/i18n/client";
import { formatMoney } from "@/lib/money";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useState } from "react";
import { api } from "@/lib/client";
import { Markdown } from "@/lib/markdown";
import { Avatar, useDirectory } from "@/lib/people";
import { btn, btnPrimary, btnSm, cx, textarea } from "@/lib/ui";
import { StatusPill } from "@/components/ui/bits";
import { ArrowRightIcon, ChatIcon, CheckIcon, CloseIcon, ForwardIcon } from "@/components/app/icons";
import { PeoplePicker } from "@/components/chat/NewConversation";
import { KindTile } from "./kindIcon";
import { ScreenCrumb } from "@/components/shell/ScreenTitle";
import { approvalHref } from "@/lib/links";
import { IconTile } from "@/components/ui/Bento";

export interface ApprovalEvent {
  id: string;
  actorId: string;
  kind: "comment" | "forwarded";
  body: string;
  targetId: string | null;
  createdAt: string;
}

export interface ApprovalData {
  id: string;
  /** Readable code (YC-007); absent only from very old payloads. */
  code?: string | null;
  title: string;
  details: string;
  requesterId: string;
  approverId: string;
  status: string;
  comment: string | null;
  onBehalfOf?: string | null;
  createdAt: string;
  decidedAt: string | null;
  canDecide: boolean;
  canCancel: boolean;
  kind?: "purchase" | "payment" | "advance" | "trip" | "other";
  amount?: number | null;
  currency?: string | null;
  fields?: Record<string, string>;
  events?: ApprovalEvent[];
  /** Approved money is summed in this request's currency only. */
  requesterStats?: { total: number; approved: number; rejected: number; approvedAmount: number; currency: string | null } | null;
}
const REASONS = ["reason_quote", "reason_budget", "reason_later", "reason_manager"] as const;

/**
 * One approval request (Vận hành, Home "Needs you", the inbox). The left column is the request and
 * its thread (sent, questions and answers, forwarded, decided); the right column is what the reader
 * can do: decide with a note, ask a question, forward it, message the requester, or withdraw it.
 */
export function ApprovalDetail({ a, peek = false }: { a: ApprovalData; /** Inside the peek dialog, whose header already shows the context. */ peek?: boolean }) {
  const { ago, dayLabel, time } = useFormat();
  const tx = useT();
  const locale = useLocale();
  const amount = a.amount ?? null;
  const currency = a.currency ?? "VND";
  const money = (n: number) => formatMoney(n, currency, locale).full;
  const router = useRouter();
  const dir = useDirectory();
  const [note, setNote] = useState("");
  const [forwardTo, setForwardTo] = useState<string[]>([]);
  const [forwarding, setForwarding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [next, setNext] = useState<{ id: string; code?: string | null; left: number } | null | undefined>(undefined);
  const pending = a.status === "pending";
  const events = a.events ?? [];
  const requester = dir.name(a.requesterId);

  const run = async (key: string, fn: () => Promise<unknown>, fail: string) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError((e as { status?: number }).status === 409 ? tx("work.approvaldetail.yeu_cau_nay_da") : fail);
      return false;
    } finally {
      setBusy(null);
    }
  };
  // After a decision, offer the next request still waiting for me, so a queue can be cleared in one go.
  const findNext = async () => {
    const r = await api<{ approvals: { id: string; code?: string | null; status: string }[] }>("work/approvals").catch(() => ({ approvals: [] }));
    const left = r.approvals.filter((x) => x.status === "pending" && x.id !== a.id);
    setNext(left[0] ? { id: left[0].id, code: left[0].code, left: left.length } : null);
  };
  const decide = async (decision: "approved" | "rejected") => {
    if (decision === "rejected" && !note.trim()) {
      setError(tx("work.approvaldetail.ghi_ly_do_tu"));
      return;
    }
    const ok = await run(
      decision,
      () => api(`work/approvals/${a.id}/decision`, { method: "POST", body: { decision, comment: note.trim() || null } }),
      tx("work.approvaldetail.chua_gui_duoc_quyet"),
    );
    if (ok) {
      void findNext();
      router.refresh();
    }
  };
  const send = async (body: string) => {
    if (!body.trim()) return;
    if (await run("reply", () => api(`work/approvals/${a.id}/comments`, { method: "POST", body: { body: body.trim() } }), tx("work.approvaldetail.sendFailed"))) router.refresh();
  };
  const forward = async () => {
    if (!forwardTo[0]) return;
    const ok = await run(
      "forward",
      () => api(`work/approvals/${a.id}/forward`, { method: "POST", body: { toUserId: forwardTo[0], note: note.trim() } }),
      tx("work.approvaldetail.forwardFailed"),
    );
    if (ok) {
      setForwarding(false);
      setNote("");
      router.refresh();
    }
  };
  const cancel = async () => {
    if (!window.confirm(tx("work.approvaldetail.rut_lai_yeu_cau_2"))) return;
    if (await run("cancel", () => api(`work/approvals/${a.id}/cancel`, { method: "POST" }), tx("work.approvaldetail.chua_rut_lai_duoc"))) router.refresh();
  };
  const message = async (userId: string) => {
    const r = await api<{ id: string }>("chat/dms", { method: "POST", body: { userId } }).catch(() => null);
    if (r) router.push(`/app/chat/${r.id}`);
  };

  // White cards on the canvas drawn by a hairline ring (the Home look); forms never lift on hover.
  const card = "bg-surface shadow-card rounded-xl";
  const fields = Object.entries(a.fields ?? {});
  const waitingDays = Math.max(0, Math.floor((Date.now() - new Date(a.createdAt).getTime()) / 86_400_000));

  return (
    // Full page: left-aligned in the app column; in the Peek drawer the same content stacks to one column.
    <div className="@container max-w-[1120px] pb-6">
      {/* The top bar shows "Yêu cầu / <title>" (one title per screen); the page keeps the title as its h1. */}
      {!peek ? <ScreenCrumb label={a.title} /> : null}
      <header className={cx("flex items-start gap-4", peek ? "mb-4" : "mb-6")}>
        {/* Phones: the eyebrow already names the kind, and the tile left the title three short lines. */}
        <span className={cx(!peek && (a.code || a.kind) && "max-sm:hidden")}>
          <KindTile kind={a.kind ?? "other"} size="lg" />
        </span>
        <div className="min-w-0 flex-1">
          {/* The code and the kind over the title. */}
          {!peek && (a.code || a.kind) ? (
            <p className="text-ink-2 m-0 mb-1 flex flex-wrap items-center gap-x-2 text-xs">
              {a.code ? <span className="font-mono tabular-nums">{a.code}</span> : null}
              {a.code && a.kind ? <span aria-hidden="true">·</span> : null}
              {a.kind ? (
                <Link href="/app/work/ops" className="text-ink-2 hover:text-ink no-underline">
                  {tx(`ops.kind_${a.kind}`)}
                </Link>
              ) : null}
            </p>
          ) : null}
          <h1 className={cx("font-display text-ink m-0 text-balance font-semibold tracking-[-0.035em]", peek ? "text-2xl/8" : "text-[28px]/[1.2] max-sm:text-2xl/8")}>{a.title}</h1>
          <p className="text-ink-2 m-0 mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <PersonChip userId={a.requesterId} dense className="text-ink" />
            <span>{tx("work.approvaldetail.sentAgo", { ago: ago(a.createdAt) })}</span>
            <ArrowRightIcon className="size-3.5 opacity-60" />
            <PersonChip userId={a.approverId} dense className="text-ink" />
            {a.onBehalfOf ? <span>{tx("work.approvaldetail.duyet_thay", { p0: dir.name(a.onBehalfOf) })}</span> : null}
          </p>
        </div>
        <StatusPill status={a.status === "cancelled" ? "cancelled" : a.status} />
      </header>

      <div className="@3xl:grid-cols-[minmax(0,1fr)_320px] grid grid-cols-1 items-start gap-5">
        <div className="grid min-w-0 gap-5">
          <section className={cx(card, "overflow-hidden")} aria-label={tx("work.approvaldetail.details")}>
            {amount ? (
              <div className="border-divider border-b px-5 py-5">
                <p className="text-ink-2 m-0 text-xs font-medium uppercase tracking-[0.08em]">{tx("work.approvaldetail.amount")}</p>
                <p className="font-display m-0 mt-1.5 text-[38px]/none font-semibold tabular-nums tracking-[-0.045em] max-sm:text-[32px]/none">{money(amount)}</p>
              </div>
            ) : null}
            {fields.length ? (
              <dl className="divide-hairline m-0 grid divide-y text-sm">
                {fields.map(([k, v]) => (
                  <Fragment key={k}>
                    <div className="grid grid-cols-[140px_minmax(0,1fr)] gap-4 px-5 py-2.5">
                      <dt className="text-ink-2">{k}</dt>
                      <dd className="m-0 whitespace-pre-wrap">{v}</dd>
                    </div>
                  </Fragment>
                ))}
              </dl>
            ) : null}
            {a.details || !fields.length ? (
              <div className={cx("px-5 py-4 text-sm", fields.length ? "border-hairline border-t" : "")}>
                {a.details ? <Markdown source={a.details} /> : <p className="text-ink-2 m-0">{tx("work.approvaldetail.khong_co_mo_ta")}</p>}
              </div>
            ) : null}
          </section>

          <section aria-label={tx("work.approvaldetail.activity")} className={cx(card, "p-5 max-sm:p-4")}>
            <h2 className="m-0 mb-4 flex min-h-8 items-center gap-3 text-sm font-semibold tracking-[-0.01em]">
              <IconTile tone="violet">
                <ChatIcon />
              </IconTile>
              {tx("work.approvaldetail.activity")}
            </h2>
            {/* The request's record in the task's forms: its steps as log rows, the questions and answers as comments. */}
            <ol className={activityList}>
              <ActivityRow who={a.requesterId} at={a.createdAt}>
                <span className="text-ink">{tx("work.approvaldetail.evSent", { name: requester })}</span>
              </ActivityRow>
              {events.map((e) =>
                e.kind === "forwarded" ? (
                  <ActivityRow key={e.id} who={e.actorId} at={e.createdAt}>
                    <span className="text-ink">{tx("work.approvaldetail.evForwarded", { name: dir.name(e.actorId), to: dir.name(e.targetId ?? "") })}</span>
                    {e.body ? <Quote>{e.body}</Quote> : null}
                  </ActivityRow>
                ) : (
                  <li key={e.id} className="relative">
                    <CommentEntry c={{ id: e.id, authorId: e.actorId, body: e.body, createdAt: e.createdAt }} className="py-1.5" />
                  </li>
                ),
              )}
              {a.decidedAt ? (
                <ActivityRow
                  who={a.status === "cancelled" ? a.requesterId : a.approverId}
                  at={a.decidedAt}
                  tone={a.status === "approved" ? "ok" : a.status === "rejected" ? "block" : undefined}
                >
                  <span className="text-ink">
                    {a.status === "approved"
                      ? tx("work.approvaldetail.evApproved", { name: dir.name(a.approverId) })
                      : a.status === "rejected"
                        ? tx("work.approvaldetail.evRejected", { name: dir.name(a.approverId) })
                        : tx("work.approvaldetail.evCancelled", { name: requester })}
                  </span>
                  {a.comment ? <Quote>{a.comment}</Quote> : null}
                </ActivityRow>
              ) : (
                <li className="relative grid grid-cols-[24px_minmax(0,1fr)] items-start gap-x-3 py-1.5 text-[13px]/5">
                  <span className="border-warn bg-surface mx-auto mt-1 size-3 rounded-full border-2" aria-hidden="true" />
                  <span className="text-ink-2 pt-0.5">
                    {waitingDays
                      ? tx("work.approvaldetail.evWaiting", { name: dir.name(a.approverId), days: waitingDays })
                      : tx("work.approvaldetail.evWaitingNew", { name: dir.name(a.approverId) })}
                  </span>
                </li>
              )}
            </ol>
            {pending && (a.canDecide || a.canCancel) ? (
              <div className="mt-4 grid gap-1.5">
                {/* Text only: a request's thread takes no files, and notifies its two people without a mention. */}
                <CommentComposer
                  id="approval-reply"
                  draftKey={`approval-reply:${a.id}`}
                  label={tx("work.approvaldetail.replyLabel")}
                  placeholder={a.canDecide ? tx("work.approvaldetail.askPlaceholder", { name: requester }) : tx("work.approvaldetail.replyPlaceholder")}
                  sendLabel={a.canDecide ? tx("work.approvaldetail.ask") : tx("work.approvaldetail.reply")}
                  mentions={false}
                  maxLength={2000}
                  onSubmit={(body) => void send(body)}
                />
                <span className="text-ink-2 px-1 text-xs">{tx("work.approvaldetail.notifyHint", { name: a.canDecide ? requester : dir.name(a.approverId) })}</span>
              </div>
            ) : null}
          </section>
        </div>

        <aside className="@3xl:sticky @3xl:top-16 grid gap-4">
          {error ? (
            <p className="bg-block-wash text-block ring-block/15 m-0 rounded-xl px-3.5 py-2.5 text-sm ring-1 ring-inset" role="alert">
              {error}
            </p>
          ) : null}
          {pending && a.canDecide ? (
            <section className={cx(card, "grid gap-3 p-4")} aria-label={tx("work.approvaldetail.quyet_dinh")}>
              <h2 className="m-0 flex min-h-8 items-center gap-3 text-sm font-semibold tracking-[-0.01em]">
                <IconTile tone="green">
                  <CheckIcon />
                </IconTile>
                {tx("work.approvaldetail.yourDecision")}
              </h2>
              <label className="grid gap-1.5 text-xs font-medium">
                {tx("work.approvaldetail.ghi_chu_bat_buoc")}
                <textarea className={cx(textarea, "min-h-20 text-sm")} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
              </label>
              <div className="flex flex-wrap gap-1.5" aria-label={tx("work.approvaldetail.quickReasons")}>
                {REASONS.map((r) => (
                  <button
                    key={r}
                    type="button"
                    className="bg-ground ring-hairline text-ink-2 hover:text-ink hover:bg-hover hover:ring-edge min-h-7 rounded-full px-2.5 text-xs ring-1 ring-inset transition-[background-color,box-shadow,color]"
                    onClick={() => setNote(tx(`work.approvaldetail.${r}`))}
                  >
                    {tx(`work.approvaldetail.${r}`)}
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <button type="button" className={cx(btnPrimary, "justify-center")} disabled={!!busy} onClick={() => void decide("approved")}>
                  <CheckIcon className="size-4" />
                  {tx("work.approvaldetail.duyet")}
                </button>
                <button type="button" className={cx(btn, "text-block justify-center")} disabled={!!busy} onClick={() => void decide("rejected")}>
                  <CloseIcon className="size-4" />
                  {tx("work.approvaldetail.tu_choi")}
                </button>
              </div>
              <div className="border-hairline border-t pt-3">
                {forwarding ? (
                  <div className="grid gap-2">
                    <p className="m-0 text-xs font-medium">{tx("work.approvaldetail.forwardTo")}</p>
                    <PeoplePicker single selected={forwardTo} onChange={setForwardTo} exclude={[a.requesterId, a.approverId]} />
                    <p className="text-ink-2 m-0 text-xs">{tx("work.approvaldetail.forwardHint")}</p>
                    <div className="flex gap-2">
                      <button type="button" className={cx(btnPrimary, btnSm)} disabled={!forwardTo[0] || busy === "forward"} onClick={() => void forward()}>
                        {tx("work.approvaldetail.forward")}
                      </button>
                      <button type="button" className={cx(btn, btnSm)} onClick={() => setForwarding(false)}>
                        {tx("common.cancel")}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button type="button" className="text-ink-2 hover:text-ink flex items-center gap-1.5 text-sm" onClick={() => setForwarding(true)}>
                    <ForwardIcon className="size-4" />
                    {tx("work.approvaldetail.forwardOpen")}
                  </button>
                )}
              </div>
            </section>
          ) : null}

          {!pending && a.canDecide && next !== undefined ? (
            <section className={cx(card, "grid gap-2 p-4")}>
              <p className="m-0 text-sm">{next ? tx("work.approvaldetail.moreLeft", { count: next.left }) : tx("work.approvaldetail.allClear")}</p>
              {next ? (
                <button type="button" className={cx(btnPrimary, "justify-center")} onClick={() => router.replace(approvalHref(next))}>
                  {tx("work.approvaldetail.openNext")}
                  <ArrowRightIcon className="size-4" />
                </button>
              ) : null}
            </section>
          ) : null}

          {pending && a.canCancel && !a.canDecide ? (
            <section className={cx(card, "grid gap-3 p-4")}>
              <p className="m-0 text-sm">
                {waitingDays
                  ? tx("work.approvaldetail.waitingFor", { name: dir.name(a.approverId), days: waitingDays })
                  : tx("work.approvaldetail.evWaitingNew", { name: dir.name(a.approverId) })}
              </p>
              <button type="button" className={btn} disabled={busy === "cancel"} onClick={() => void cancel()}>
                {tx("work.approvaldetail.rut_lai_yeu_cau")}
              </button>
            </section>
          ) : null}

          <section className={cx(card, "grid gap-3 p-4")} aria-label={tx("work.approvaldetail.people")}>
            {[
              { id: a.requesterId, role: tx("work.approvaldetail.nguoi_gui") },
              { id: a.approverId, role: tx("work.approvaldetail.nguoi_duyet") },
            ]
              .filter((x) => x.id !== dir.me)
              .map((x) => (
                <div key={x.id} className="flex items-center gap-2.5">
                  <PersonTrigger userId={x.id} className="group/person flex min-w-0 flex-1 items-center gap-2.5 rounded-md">
                    <Avatar id={x.id} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium group-hover/person:underline">{dir.name(x.id)}</span>
                      <span className="text-ink-2 block text-xs">{x.role}</span>
                    </span>
                  </PersonTrigger>
                  <button type="button" className={cx(btn, btnSm)} onClick={() => void message(x.id)} aria-label={tx("work.approvaldetail.messageName", { name: dir.name(x.id) })}>
                    <ChatIcon className="size-4" />
                  </button>
                </div>
              ))}
            {a.requesterStats ? (
              <p className="border-hairline text-ink-2 m-0 border-t pt-3 text-xs">
                {a.requesterStats.total
                  ? tx("work.approvaldetail.history", {
                      name: requester,
                      total: a.requesterStats.total,
                      approved: a.requesterStats.approved,
                      rejected: a.requesterStats.rejected,
                    })
                  : tx("work.approvaldetail.historyFirst", { name: requester })}
                {a.requesterStats.approvedAmount ? (
                  <>
                    {" "}
                    {tx("work.approvaldetail.historyAmount")}{" "}
                    <span className="text-ink font-semibold tabular-nums">{formatMoney(a.requesterStats.approvedAmount, a.requesterStats.currency ?? currency, locale).full}</span>.
                  </>
                ) : null}
              </p>
            ) : null}
            {a.decidedAt ? (
              <p className="border-hairline text-ink-2 m-0 border-t pt-3 text-xs">
                {tx("work.approvaldetail.xu_ly_luc")}{" "}
                <span className="text-ink tabular-nums">
                  {dayLabel(a.decidedAt)} {time(a.decidedAt)}
                </span>
              </p>
            ) : null}
          </section>
        </aside>
      </div>
    </div>
  );
}

/** A note that came with a step (forwarded with…, decided because…). */
function Quote({ children }: { children: string }) {
  return (
    <div className="bg-hover text-ink m-0 mt-1.5 whitespace-pre-wrap rounded-lg px-3 py-2 text-sm">
      <CommentBody body={children} />
    </div>
  );
}
