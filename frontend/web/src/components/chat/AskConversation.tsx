"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import { useFormat, useT } from "@/lib/i18n/client";
import { useDirectory } from "@/lib/people";
import { taskHref } from "@/lib/links";
import { Markdown } from "@/lib/markdown";
import { btn, btnGhost, btnPrimary, btnSm, cx, iconBtn, meta } from "@/lib/ui";
import { useConfirm } from "@/components/ui/Confirm";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { ApprovalIcon, ArrowUpIcon, BotIcon, CheckIcon, ChevronDownIcon, ChevronLeftIcon, CopyIcon, FileIcon, PencilIcon, StopIcon } from "@/components/app/icons";
import { ScreenCrumb } from "@/components/shell/ScreenTitle";
import { asksChanged } from "@/components/workflows/AskForm";
import { useAskOutcome } from "@/components/workflows/AskHistory";
import { Quoted, RunStatusChip, StepBar } from "@/components/workflows/bits";
import { RunSteps } from "@/components/workflows/RunSteps";
import { useApproverWait } from "@/components/workflows/run/approver";
import { RunLogButton } from "@/components/workflows/run/RunLogButton";
import { ACTIVE, MAX_ASK_ROUNDS, type AskQuestion, type AskRound, type AskThread } from "@/components/workflows/types";
import { useToast } from "@/components/ui/Toast";

// One reading column, like any chat: the thread, and the composer under it.
const wrap = "mx-auto w-full max-w-[760px] px-4 md:px-6";
type Step = AskThread["run"]["steps"][number];

/** "Ship a change: plan → approve → code → review → PR" names its steps, which the steps line already shows: keep the name part. */
const workflowLabel = (name: string) => (name.includes("→") ? name.split(":")[0]!.trim() || name : name);

/** The AI's side of the conversation: its mark, who and when, then a bubble; `after` holds what it offers to pick. */
function AiMessage({
  step,
  at,
  children,
  after,
  bare,
  cont,
}: {
  step?: string;
  at?: string;
  children: React.ReactNode;
  after?: React.ReactNode;
  /** The children bring their own surface (a document). */
  bare?: boolean;
  /** Goes on from the AI's message right above: no mark or name again. */
  cont?: boolean;
}) {
  const t = useT();
  return (
    <div className="animate-rise flex min-w-0 items-start gap-2.5 pr-6 md:pr-16">
      <span
        aria-hidden="true"
        className={cx("bg-violet-wash text-violet-text mt-5 grid size-7 shrink-0 place-items-center rounded-full [&_svg]:size-4", cont && "invisible mt-0 h-0")}
      >
        <BotIcon />
      </span>
      <div className="grid min-w-0 flex-1 justify-items-start gap-1.5">
        {cont ? null : (
          <p className={cx(meta, "m-0 flex min-w-0 max-w-full items-center gap-1.5 px-1")}>
            <span className="text-ink-soft font-medium">{t("workflows.ask.ai")}</span>
            {step ? <span className="min-w-0 truncate">· {step}</span> : null}
            {at ? (
              <span className="shrink-0" suppressHydrationWarning>
                · {at}
              </span>
            ) : null}
          </p>
        )}
        <div className={cx("text-ink min-w-0 max-w-full text-sm/[1.55] [overflow-wrap:anywhere]", !bare && "bg-surface shadow-card rounded-2xl rounded-tl-md px-4 py-2.5")}>
          {children}
        </div>
        {after}
      </div>
    </div>
  );
}

/** A person's words in the conversation: an answer, a change request, a note given with an approval. */
function Reply({ who, label, at, muted, onEdit, children }: { who?: string; label?: string; at?: string; muted?: boolean; onEdit?: () => void; children: React.ReactNode }) {
  const t = useT();
  const tail = [label, at].filter(Boolean).join(" · ");
  return (
    <div className="animate-rise grid min-w-0 justify-items-end gap-1 pl-10 md:pl-24">
      {who || tail ? (
        <p className={cx(meta, "m-0 max-w-full truncate px-1")} suppressHydrationWarning>
          {who ? <span className="text-ink-soft font-medium">{who}</span> : null}
          {who && tail ? " · " : ""}
          {tail}
        </p>
      ) : null}
      <div className="flex min-w-0 max-w-full items-center gap-1">
        {onEdit ? (
          <button type="button" className={cx(iconBtn, "size-7 shrink-0")} aria-label={t("workflows.ask.change")} title={t("workflows.ask.change")} onClick={onEdit}>
            <PencilIcon />
          </button>
        ) : null}
        <div
          className={cx(
            "min-w-0 max-w-full whitespace-pre-wrap rounded-2xl rounded-br-md px-4 py-2.5 text-sm/[1.55] [overflow-wrap:anywhere]",
            muted ? "bg-hover text-ink-2" : "bg-brand text-on-brand",
          )}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

/** A quiet line for what happened without words (approved, a round left to the AI, who started the run). */
function Event({ children, at, plain }: { children: React.ReactNode; at?: string; plain?: boolean }) {
  return (
    <p className={cx(meta, "m-0 flex min-w-0 items-center justify-center gap-1.5 px-2 text-center")}>
      {plain ? null : <CheckIcon className="text-ok size-3.5 shrink-0" />}
      <span className="min-w-0 truncate">{children}</span>
      {at ? (
        <span className="shrink-0 tabular-nums" suppressHydrationWarning>
          · {at}
        </span>
      ) : null}
    </p>
  );
}

/** What the AI offers to pick, right under its message: a pill per choice. */
const pick =
  // On a phone a pill is a full thumb target (44px), since this is where people arrive from a notification.
  "inline-flex min-h-9 max-w-full items-center gap-1.5 rounded-full px-3.5 text-left text-[13px] font-medium ring-1 ring-inset transition-colors disabled:opacity-50 max-sm:min-h-11 [&_svg]:size-3.5 [&_svg]:shrink-0";
const pickPlain = "bg-surface text-ink ring-edge hover:bg-hover active:bg-selected";
const pickQuiet = "text-ink-2 ring-transparent hover:bg-hover hover:text-ink";

/** What a person is answering right now: kept in the browser until the round is sent. */
interface Draft {
  /** A key per question already passed; "" is an optional question left without an answer. */
  answers: Record<string, string>;
  /** The question in hand; past the last one, everything is ready to send. */
  at: number;
}

/**
 * A round of questions as a conversation: the AI asks one question a message, a person's answer follows it. A closed
 * round shows what was answered; the open one stops at the question in hand, whose choices are pills under it (the
 * AI's own guess marked), and earlier answers can be changed until the round is sent.
 */
function RoundThread({
  r,
  step,
  when,
  draft,
  onPick,
  onEdit,
  busy,
}: {
  r: AskRound;
  step: string;
  when: (iso: string) => string;
  /** The open round, for whoever may answer it. */
  draft?: Draft;
  onPick?: (q: AskQuestion, v: string) => void;
  onEdit?: (i: number) => void;
  busy?: boolean;
}) {
  const t = useT();
  const dir = useDirectory();
  const outcome = useAskOutcome();
  const closed = !!r.closedAt;
  const stepLabel = r.round > 1 ? `${step} · ${t("workflows.ask.round", { n: r.round, max: Math.max(MAX_ASK_ROUNDS, r.round) })}` : step;
  // A reader who may not answer sees every question; someone answering sees them come one at a time.
  const upTo = closed || !draft ? r.questions.length - 1 : Math.min(draft.at, r.questions.length - 1);
  const who = closed && r.answeredBy ? dir.name(r.answeredBy) : undefined;
  return (
    <>
      {r.questions.slice(0, upTo + 1).map((q, i) => {
        const asking = !!draft && !closed && i === draft.at;
        const given = closed ? r.answers?.[q.id] : draft && i !== draft.at && q.id in draft.answers ? draft.answers[q.id] : undefined;
        const answered = closed ? r.outcome === "answered" || !!given : given !== undefined;
        const guess = q.default?.trim();
        const options = q.kind === "choice" ? (q.options ?? []) : [];
        return (
          <li key={q.id} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3">
            <AiMessage
              step={i === 0 ? stepLabel : r.questions.length > 1 ? t("workflows.ask.qOf", { n: i + 1, count: r.questions.length }) : undefined}
              at={i === 0 ? when(r.askedAt) : undefined}
              after={
                asking ? (
                  <div role="group" aria-label={t("workflows.ask.pickLabel")} className="flex min-w-0 max-w-full flex-wrap gap-1.5 pt-0.5">
                    {options.map((o) => (
                      <button key={o} type="button" disabled={busy} className={cx(pick, pickPlain)} onClick={() => onPick?.(q, o)}>
                        <span className="min-w-0 break-words py-1.5">{o}</span>
                        {guess === o ? (
                          <span className="text-violet-text bg-violet-wash -mr-1.5 shrink-0 rounded-full px-1.5 py-0.5 text-[11px]">{t("workflows.ask.suggested")}</span>
                        ) : null}
                      </button>
                    ))}
                    {/* The AI's best guess from the task: one press takes it. */}
                    {guess && !options.includes(guess) ? (
                      <button type="button" disabled={busy} className={cx(pick, pickPlain)} onClick={() => onPick?.(q, guess)}>
                        <span className="min-w-0 break-words py-1.5">{guess}</span>
                        <span className="text-violet-text bg-violet-wash -mr-1.5 shrink-0 rounded-full px-1.5 py-0.5 text-[11px]">{t("workflows.ask.suggested")}</span>
                      </button>
                    ) : null}
                    {q.required === false ? (
                      <button type="button" disabled={busy} className={cx(pick, pickQuiet)} onClick={() => onPick?.(q, "")}>
                        {t("workflows.ask.skipOne")}
                      </button>
                    ) : null}
                  </div>
                ) : null
              }
            >
              {i === 0 ? <p className="text-ink-2 m-0 mb-1">{t(r.round > 1 ? "workflows.ask.leadMore" : "workflows.ask.lead", { step, count: r.questions.length })}</p> : null}
              <p className="m-0 font-medium">
                {q.text}
                {q.required === false ? <span className="text-ink-2 ml-1.5 text-xs font-normal">({t("workflows.ask.optional")})</span> : null}
              </p>
            </AiMessage>
            {answered ? (
              <Reply
                who={i === 0 ? who : undefined}
                at={i === 0 && closed && r.answeredAt ? when(r.answeredAt) : undefined}
                muted={!given}
                onEdit={!closed && onEdit && !busy ? () => onEdit(i) : undefined}
              >
                {given || t("workflows.ask.noAnswer")}
              </Reply>
            ) : null}
          </li>
        );
      })}
      {closed && r.outcome !== "answered" ? (
        <li>
          <Event at={when(r.closedAt!)}>{outcome(r)}</Event>
        </li>
      ) : null}
      {draft && !closed && draft.at >= r.questions.length ? (
        <li>
          <AiMessage>{t("workflows.ask.ready", { count: r.questions.length })}</AiMessage>
        </li>
      ) : null}
    </>
  );
}

/** The result under review, as a document in the AI's message: a copy button, the Markdown, folded when long. */
function Deliverable({ step, made }: { step: Step; made?: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = body.current;
    if (el) setLong(el.scrollHeight > 460);
  }, [step.review]);
  return (
    <article className="bg-surface shadow-card w-full min-w-0 overflow-hidden rounded-2xl rounded-tl-md">
      <header className="border-divider flex min-h-11 min-w-0 items-center gap-2 border-b px-4 py-1.5">
        <FileIcon className="text-ink-2 size-4 shrink-0" />
        <span className="text-ink min-w-0 truncate text-[13px] font-medium">
          <Quoted text={t("workflows.ask.draftFrom", { step: step.reviewFrom ?? "" })} />
        </span>
        {made ? (
          <span className={cx(meta, "shrink-0 max-sm:hidden")} suppressHydrationWarning>
            · {made}
          </span>
        ) : null}
        <button
          type="button"
          className={cx(btnGhost, btnSm, "ml-auto shrink-0")}
          onClick={() => {
            void navigator.clipboard?.writeText(step.review ?? "").then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? <CheckIcon className="text-ok" /> : <CopyIcon />}
          {copied ? t("workflows.ask.copied") : t("workflows.ask.copy")}
        </button>
      </header>
      <div className="relative">
        <div
          ref={body}
          className={cx(
            "text-ink min-w-0 px-4 py-4 md:px-6 [&>div>:first-child]:mt-0 [&>div>:last-child]:mb-0 [&>div]:text-sm/[1.6] [&_h1]:text-base [&_h2]:text-[15px] [&_h3]:text-sm",
            long && !open && "max-h-[420px] overflow-hidden",
          )}
        >
          <Markdown source={step.review ?? ""} copyCode={{ label: t("aiw.chat.copyCode"), done: t("aiw.chat.copiedCode") }} />
        </div>
        {long && !open ? <div aria-hidden="true" className="from-surface pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t to-transparent" /> : null}
      </div>
      {long ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="border-divider text-ink-soft hover:bg-hover hover:text-ink flex min-h-10 w-full items-center justify-center gap-1.5 border-t text-[13px] font-medium transition-colors"
        >
          {t(open ? "workflows.ask.showLess" : "workflows.ask.showAll")}
          <ChevronDownIcon className={cx("size-4 transition-transform", open && "rotate-180")} />
        </button>
      ) : null}
    </article>
  );
}

/** The run's steps: one line with the bar and the step in hand; opened, the full list and who started the run. */
function StepsLine({ thread, label, started }: { thread: AskThread; label: string; started: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const { run } = thread;
  const done = run.steps.filter((s) => s.state === "done" || s.state === "skipped").length;
  return (
    <div className="border-hairline bg-surface shrink-0 border-b">
      <div className={wrap}>
        <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="flex min-h-10 w-full min-w-0 items-center gap-3 text-left">
          <StepBar steps={run.steps} className="w-24 shrink-0" />
          <span className={cx(meta, "min-w-0 flex-1 truncate")}>
            <span className="text-ink-soft tabular-nums">{t("workflows.ask.stepOf", { n: Math.min(done + 1, run.steps.length), count: run.steps.length })}</span>
            {run.steps[run.currentStep] ? ` · ${run.steps[run.currentStep]!.title}` : ""}
          </span>
          <ChevronDownIcon className={cx("text-ink-2 size-4 shrink-0 transition-transform", open && "rotate-180")} />
        </button>
        {open ? (
          <div className="border-divider max-h-[50dvh] overflow-y-auto border-t pb-3 pt-2">
            <RunSteps run={run} size="sm" label={label} />
            <p className={cx(meta, "m-0 px-1.5 pt-2")} suppressHydrationWarning>
              {started}
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The box a person types in, docked under the thread: Enter sends, Shift+Enter makes a new line. */
function Composer({
  value,
  onChange,
  onSend,
  field,
  placeholder,
  label,
  hint,
  error,
  busy,
  left,
  send,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  field: React.RefObject<HTMLTextAreaElement | null>;
  placeholder: string;
  label: string;
  hint?: string;
  error?: string | null;
  busy?: boolean;
  /** Quiet actions at the start of the bottom row ("Let the AI decide", "Stop the run"). */
  left?: React.ReactNode;
  /** Replaces the round send button (an approval names what sending does). */
  send?: React.ReactNode;
}) {
  const t = useT();
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSend();
      }}
      className="bg-surface border-hairline focus-within:border-ink/30 focus-within:ring-selected grid min-w-0 rounded-2xl border px-1 pt-1 transition-shadow focus-within:ring-[3px]"
    >
      <textarea
        ref={field}
        rows={1}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
          e.preventDefault();
          onSend();
        }}
        aria-label={label}
        aria-invalid={error ? true : undefined}
        placeholder={placeholder}
        className="text-ink placeholder:text-ink-2/80 max-h-48 min-h-11 w-full resize-none bg-transparent px-3 py-2.5 text-sm/6 outline-none [field-sizing:content] max-md:text-base/6"
      />
      <div className="flex min-w-0 items-center gap-1.5 px-1 pb-1.5">
        {left}
        {error ? (
          <p role="alert" className="text-block m-0 min-w-0 flex-1 truncate px-1 text-xs">
            {error}
          </p>
        ) : (
          <p className="text-ink-2/80 m-0 min-w-0 flex-1 truncate px-1 text-right text-xs max-md:invisible">{hint}</p>
        )}
        {send ?? (
          <button
            type="submit"
            disabled={busy || !value.trim()}
            aria-label={t("workflows.ask.sendOne")}
            className="bg-brand text-on-brand hover:bg-brand/90 grid size-8 shrink-0 place-items-center rounded-full transition-[background-color,transform] active:scale-95 disabled:opacity-30"
          >
            <ArrowUpIcon className="size-4" />
          </button>
        )}
      </div>
    </form>
  );
}

type Item =
  { kind: "round"; i: number; round: AskRound } | { kind: "rework"; i: number; note: string; by: string; at: string } | { kind: "approved"; i: number; at?: string; note?: string };

/**
 * A run's conversation for what it needs from people (/app/chat/ask/<run>, docs/architecture/agent-questions.md), built
 * from the run, never stored as a chat channel. It reads like any chat: the AI's messages on the left (a
 * question at a time, or the result it wants approved), the reader's answers on the right, and one composer docked
 * under the thread. What the AI offers to pick (a question's choices, approve / request changes / stop) are pills
 * under its message; anything else is typed. It reads the run again every few seconds while the tab is visible and the
 * run goes on, so a second round, or the end, shows up by itself.
 */
export function AskConversation({ runId, initial }: { runId: string; initial: AskThread | null }) {
  const t = useT();
  const { confirm, dialog } = useConfirm();
  const waitsFor = useApproverWait();
  const router = useRouter();
  const dir = useDirectory();
  const toast = useToast();
  const { dayLabel, time } = useFormat();
  const [thread, setThread] = useState(initial);
  const [failed, setFailed] = useState(!initial);
  const scroller = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  // What is typed in the composer: an answer, or a change request / approval note.
  const [text, setText] = useState("");
  const [roundDraft, setRoundDraft] = useState<Draft & { id: string }>({ id: "", answers: {}, at: 0 });
  const [busy, setBusy] = useState<"answer" | "skip" | "approve" | "rework" | "stop" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setThread(await api<AskThread>(`work/runs/${runId}/questions`));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [runId]);

  const open = !!thread?.rounds.some((r) => !r.closedAt) || thread?.run.status === "waiting_approval";
  const live = !!thread && ACTIVE.includes(thread.run.status);
  useEffect(() => {
    if (!live) return;
    // Waiting on people is slow; the AI working is quick: read again sooner then.
    const id = window.setInterval(() => document.visibilityState === "visible" && void load(), open ? 10_000 : 3000);
    return () => window.clearInterval(id);
  }, [live, open, load]);

  const openRound = thread?.rounds.find((r) => !r.closedAt);
  const draft: Draft = openRound && roundDraft.id === openRound.id ? roundDraft : { answers: {}, at: 0 };
  const rounds = thread?.rounds.length ?? 0;
  const status = thread?.run.status;
  // Like any chat, the newest message is in view: a new question, an answer just given, the AI going on.
  const steps = Object.keys(draft.answers).length;
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [rounds, status, draft.at, steps]);
  // The sidebar item goes once nothing waits on people.
  useEffect(() => {
    if (status && status !== "waiting_input" && status !== "waiting_approval") asksChanged();
  }, [status]);

  if (!thread)
    return (
      <div className={cx(wrap, "py-10")}>
        <LoadFailed what={t("workflows.ask.title")} onRetry={() => void load()} />
      </div>
    );

  const { run, task } = thread;
  const when = (iso: string) => `${dayLabel(iso)} ${time(iso)}`;
  const approval = run.status === "waiting_approval";
  const current = run.steps[run.currentStep];
  const next = run.steps[run.currentStep + 1]?.title;
  const reviewed = approval ? current : undefined;
  const madeAt = reviewed ? run.steps.find((s) => s.title === reviewed.reviewFrom && s.finishedAt)?.finishedAt : undefined;
  // The bar names the task (otherwise phones show only "Messages").
  const crumb = `${task.code} · ${task.title}`;
  const stepsLabel = t("workflows.ask.progress");
  const started = `${t("workflows.ask.startedBy", { name: dir.name(run.startedBy) })}${run.steps[0]?.startedAt ? ` · ${when(run.steps[0].startedAt)}` : ""}`;
  const answering = !!openRound && thread.canAnswer;
  const questions = openRound?.questions ?? [];
  const asked = answering ? questions[draft.at] : undefined;

  const sendAnswers = async (answers: Record<string, string>, skip: boolean) => {
    if (!openRound) return;
    const filled = Object.fromEntries(Object.entries(answers).filter(([, v]) => v.trim()));
    setBusy(skip ? "skip" : "answer");
    setError(null);
    try {
      // "Let the AI decide" sends what was already answered: the AI decides only the rest.
      await api(`work/agent-questions/${openRound.id}/answer`, { method: "POST", body: skip ? { skip: true, answers: filled } : { answers: filled } });
      asksChanged();
      await load();
    } catch (e) {
      if ((e as { status?: number }).status === 409) {
        // Someone else answered first: the thread shows their answers.
        toast({ message: t("workflows.ask.already") });
        asksChanged();
        await load();
      } else setError((e as { body?: { message?: string } }).body?.message ?? t("workflows.ask.failed"));
    }
    setBusy(null);
  };
  /** An answer to the question in hand: on to the next one not yet passed; a typed last answer sends the round. */
  const answer = (q: AskQuestion, v: string, typed: boolean) => {
    if (!openRound || busy) return;
    const answers = { ...draft.answers, [q.id]: v.trim() };
    const from = questions.findIndex((x) => x.id === q.id);
    const at = questions.findIndex((x, i) => i > from && !(x.id in answers));
    setRoundDraft({ id: openRound.id, answers, at: at < 0 ? questions.length : at });
    setText("");
    setError(null);
    // A pick on the last question waits for "Send answers" (a slip of the finger can still be changed); Enter is deliberate.
    if (at < 0 && typed) void sendAnswers(answers, false);
    else if (window.matchMedia("(pointer: fine)").matches) field.current?.focus({ preventScroll: true });
  };
  const edit = (i: number) => {
    if (!openRound) return;
    const answers = { ...draft.answers };
    const was = answers[questions[i]!.id] ?? "";
    delete answers[questions[i]!.id];
    setRoundDraft({ id: openRound.id, answers, at: i });
    // A typed answer comes back into the box to correct; a picked one is picked again.
    setText(questions[i]!.options?.includes(was) ? "" : was);
    field.current?.focus({ preventScroll: true });
  };
  const decide = async (kind: "approve" | "rework" | "stop") => {
    if (kind === "stop" && !(await confirm({ title: t("workflows.ask.stop"), body: t("workflows.ask.stopConfirm"), confirmLabel: t("workflows.ask.stop"), danger: true }))) return;
    setBusy(kind);
    try {
      await api(`work/runs/${runId}/${kind === "stop" ? "cancel" : kind}`, { method: "POST", body: kind === "stop" ? {} : { note: text.trim() } });
      setText("");
      asksChanged();
      await load();
    } catch {
      toast({ message: t("common.actionFailed") });
    }
    setBusy(null);
  };
  const has = !!text.trim();

  // The conversation in step order: a step's change requests and rounds of questions, an approval once given.
  const items: Item[] = [];
  run.steps.forEach((s, i) => {
    if (s.rework) items.push({ kind: "rework", i, note: s.rework.note, by: s.rework.by, at: s.rework.at });
    for (const r of thread.rounds.filter((x) => x.stepIndex === i).sort((a, b) => a.round - b.round)) items.push({ kind: "round", i, round: r });
    if (s.kind === "approval" && s.state === "done") items.push({ kind: "approved", i, at: s.finishedAt, note: s.note || undefined });
  });

  // What the AI says last when it asks nothing: the result to approve, that it is working, or how the run ended.
  const tail = approval ? (
    <li className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2">
      <AiMessage step={reviewed?.title} at={reviewed?.startedAt ? when(reviewed.startedAt) : undefined}>
        <p className="m-0">
          <Quoted text={reviewed?.reviewFrom ? t("workflows.ask.reviewSay", { step: reviewed.reviewFrom }) : t("workflows.ask.reviewSayNone", { step: reviewed?.title ?? "" })} />
        </p>
      </AiMessage>
      {reviewed?.review ? (
        <AiMessage bare cont>
          <Deliverable step={reviewed} made={madeAt ? when(madeAt) : undefined} />
        </AiMessage>
      ) : null}
      <AiMessage
        cont
        after={
          thread.canApprove ? (
            // Phones: the two decisions side by side across the column, each a thumb wide; stopping the run sits apart, below.
            <div
              role="group"
              aria-label={t("workflows.ask.decision")}
              className="flex min-w-0 max-w-full flex-wrap gap-1.5 pt-0.5 max-sm:grid max-sm:w-full max-sm:grid-cols-2 max-sm:gap-2"
            >
              <button
                type="button"
                disabled={!!busy}
                className={cx(pick, "bg-brand text-on-brand hover:bg-brand/90 ring-transparent max-sm:justify-center", !reviewed?.reviewFrom && "max-sm:col-span-2")}
                onClick={() => void decide("approve")}
              >
                <ApprovalIcon />
                {busy === "approve" ? t("workflows.ask.approving") : has ? t("workflows.ask.approveNote") : t("workflows.ask.approve")}
              </button>
              {reviewed?.reviewFrom ? (
                <button
                  type="button"
                  disabled={!!busy}
                  className={cx(pick, pickPlain, "max-sm:justify-center")}
                  onClick={() => (has ? void decide("rework") : field.current?.focus())}
                >
                  <PencilIcon />
                  {busy === "rework" ? t("workflows.ask.reworking") : t("workflows.ask.rework")}
                </button>
              ) : null}
              <button
                type="button"
                disabled={!!busy}
                className={cx(pick, pickQuiet, "hover:text-block max-sm:col-span-2 max-sm:justify-self-start")}
                onClick={() => void decide("stop")}
              >
                <StopIcon />
                {t("workflows.ask.stop")}
              </button>
            </div>
          ) : null
        }
      >
        <p className="m-0">
          {reviewed?.review ? "" : `${t("workflows.ask.reviewEmpty")} `}
          <Quoted text={next ? t("workflows.ask.reviewNext", { next }) : t("workflows.ask.reviewEnd")} />
        </p>
        {/* What an automatic check found and let through (its workflow says "go on"): the approver decides knowing it. */}
        {reviewed?.issues?.length ? (
          <div className="bg-warn-wash text-warn mt-2 rounded-lg px-3 py-2 text-[13px]">
            <p className="m-0 font-medium">{t("workflows.run.issuesLeft")}</p>
            <ul className="m-0 mt-1 grid list-disc gap-0.5 pl-4">
              {reviewed.issues.map((x, i) => (
                <li key={i}>{x}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {thread.canApprove ? (
          <p className="text-ink-2 m-0 mt-1">
            <Quoted
              text={reviewed?.reviewFrom ? t("workflows.ask.decisionHint", { step: reviewed.reviewFrom }) : t("workflows.ask.decisionHintNone", { step: reviewed?.title ?? "" })}
            />
          </p>
        ) : (
          <p className="text-ink-2 m-0 mt-1">{waitsFor(reviewed, run.startedBy)}</p>
        )}
      </AiMessage>
    </li>
  ) : openRound ? null : run.status === "running" || run.status === "queued" ? (
    <li>
      <AiMessage step={current?.title}>
        <span className="text-ink-2 inline-flex items-center gap-2">
          <span className="flex gap-1" aria-hidden="true">
            {["", "[animation-delay:160ms]", "[animation-delay:320ms]"].map((d) => (
              <span key={d} className={cx("bg-ink-2 size-1.5 rounded-full motion-safe:animate-pulse", d)} />
            ))}
          </span>
          {run.runner === "local" && run.status === "queued" ? t("workflows.ask.queuedLocal") : <Quoted text={t("workflows.ask.working", { step: current?.title ?? "" })} />}
        </span>
      </AiMessage>
    </li>
  ) : run.status === "done" || run.status === "failed" || run.status === "cancelled" || run.status === "paused" ? (
    <li>
      <AiMessage>
        <p className="m-0 flex items-center gap-2 font-medium">
          <span
            aria-hidden="true"
            className={cx(
              "grid size-5 shrink-0 place-items-center rounded-full [&_svg]:size-3",
              run.status === "done" ? "bg-ok-wash text-ok" : run.status === "failed" ? "bg-block-wash text-block" : "bg-hover text-ink-2",
            )}
          >
            {run.status === "done" ? <CheckIcon /> : <StopIcon />}
          </span>
          {run.status === "done"
            ? t("workflows.ask.finished")
            : run.status === "failed"
              ? t("workflows.ask.failedRun")
              : run.status === "paused"
                ? t("workflows.status.paused")
                : t("workflows.ask.cancelled")}
        </p>
        <p className="text-ink-2 m-0 mt-1 break-words">
          {run.status === "failed"
            ? run.error || <Quoted text={t("workflows.ask.failedHint", { step: run.steps.find((s) => s.state === "failed")?.title ?? current?.title ?? "" })} />
            : run.status === "done"
              ? t("workflows.ask.doneHint")
              : t("workflows.ask.closed")}
        </p>
        <Link href={taskHref({ id: task.id, code: task.code })} className="text-accent-text mt-1.5 inline-block text-[13px] font-medium hover:underline">
          {t("workflows.ask.seeResult")}
        </Link>
      </AiMessage>
    </li>
  ) : null;

  const quiet = cx(btnGhost, btnSm, "text-ink-2 shrink-0");
  const dock = answering ? (
    draft.at >= questions.length ? (
      // Every question passed: one press sends the round.
      <div className="grid gap-2">
        {error ? (
          <p role="alert" className="text-block m-0 px-1 text-xs">
            {error}
          </p>
        ) : null}
        <div className="flex min-w-0 items-center gap-2">
          <button type="button" className={quiet} disabled={!!busy} title={t("workflows.ask.skipHint")} onClick={() => void sendAnswers(draft.answers, true)}>
            {t("workflows.ask.skip")}
          </button>
          <button type="button" autoFocus className={cx(btnPrimary, "ml-auto min-h-10 rounded-full px-5")} disabled={!!busy} onClick={() => void sendAnswers(draft.answers, false)}>
            {busy === "answer" ? t("workflows.ask.reworking") : t("workflows.ask.send")}
            <ArrowUpIcon />
          </button>
        </div>
      </div>
    ) : (
      <Composer
        field={field}
        value={text}
        onChange={(v) => {
          setText(v);
          if (error) setError(null);
        }}
        onSend={() => asked && text.trim() && answer(asked, text, true)}
        busy={!!busy}
        error={error}
        label={asked?.text ?? t("workflows.ask.form")}
        placeholder={t(asked?.kind === "choice" && asked.options?.length ? "workflows.ask.answerPickPh" : "workflows.ask.answerTypePh")}
        hint={t(questions.every((x, i) => i === draft.at || x.id in draft.answers) ? "workflows.ask.keysLast" : "workflows.ask.keys")}
        left={
          <button type="button" className={quiet} disabled={!!busy} title={t("workflows.ask.skipHint")} onClick={() => void sendAnswers(draft.answers, true)}>
            {t("workflows.ask.skip")}
          </button>
        }
      />
    )
  ) : openRound ? (
    <p className="text-ink-2 m-0 px-2 py-2 text-center text-[13px]">{t("workflows.ask.readOnly")}</p>
  ) : approval && thread.canApprove ? (
    <Composer
      field={field}
      value={text}
      onChange={setText}
      // Words sent back are a change request; with nothing to send back to, they are the note of an approval.
      onSend={() => has && void decide(reviewed?.reviewFrom ? "rework" : "approve")}
      busy={!!busy}
      label={t("workflows.ask.noteLabel")}
      placeholder={reviewed?.reviewFrom ? t("workflows.ask.notePlaceholder") : t("workflows.ask.noteOnlyPh")}
      hint={reviewed?.reviewFrom ? t("workflows.ask.keysRework") : undefined}
      send={
        <>
          {has && reviewed?.reviewFrom ? (
            <button type="button" className={cx(btn, btnSm, "shrink-0 rounded-full")} disabled={!!busy} onClick={() => void decide("approve")}>
              {t("workflows.ask.approveNote")}
            </button>
          ) : null}
          <button type="submit" className={cx(btnPrimary, btnSm, "shrink-0 rounded-full px-3")} disabled={!!busy || !has}>
            {reviewed?.reviewFrom ? (busy === "rework" ? t("workflows.ask.reworking") : t("workflows.ask.rework")) : t("workflows.ask.approveNote")}
            <ArrowUpIcon />
          </button>
        </>
      }
    />
  ) : approval ? (
    <p className="text-ink-2 m-0 px-2 py-2 text-center text-[13px]">{t("workflows.ask.noApprove")}</p>
  ) : null;

  return (
    <div className="bg-ground flex h-full min-h-0 flex-col">
      <ScreenCrumb label={crumb} />
      {dialog}
      <header className="border-hairline bg-surface shrink-0 border-b">
        <div className={cx(wrap, "flex min-h-14 min-w-0 items-center gap-3 py-2")}>
          <button
            type="button"
            className={cx(iconBtn, "-ml-1.5 shrink-0")}
            aria-label={t("common.back")}
            onClick={() => (window.history.length > 1 ? router.back() : router.push("/app/chat"))}
          >
            <ChevronLeftIcon />
          </button>
          <div className="grid min-w-0 flex-1">
            <h1 className="text-ink m-0 flex min-w-0 items-baseline gap-2 text-sm/5 font-semibold">
              <span className="text-ink-2 shrink-0 font-mono text-xs font-medium">{task.code}</span>
              <span className="min-w-0 truncate">{task.title}</span>
            </h1>
            <p className={cx(meta, "m-0 truncate")} title={run.workflowName}>
              {workflowLabel(run.workflowName)}
              {current && ACTIVE.includes(run.status) ? ` · ${current.title}` : ""}
            </p>
          </div>
          <span className="max-sm:hidden">
            <RunStatusChip status={run.status} />
          </span>
          <RunLogButton taskId={task.id} runId={run.id} className="shrink-0" />
          <Link href={taskHref({ id: task.id, code: task.code })} className={cx(btn, btnSm, "shrink-0")}>
            {t("workflows.ask.openTask")}
          </Link>
        </div>
      </header>
      <StepsLine thread={thread} label={stepsLabel} started={started} />
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <main className={cx(wrap, "grid grid-cols-[minmax(0,1fr)] gap-4 py-5")}>
          <Event plain>{started}</Event>
          <ol className="m-0 grid list-none grid-cols-[minmax(0,1fr)] gap-4 p-0" aria-label={t("workflows.ask.conversation", { code: task.code })}>
            {items.map((x) => {
              const stepTitle = run.steps[x.i]?.title ?? "";
              if (x.kind === "round")
                return (
                  <RoundThread
                    key={x.round.id}
                    r={x.round}
                    step={stepTitle}
                    when={when}
                    draft={!x.round.closedAt && answering ? draft : undefined}
                    onPick={(q, v) => answer(q, v, false)}
                    onEdit={edit}
                    busy={!!busy}
                  />
                );
              if (x.kind === "rework")
                return x.by === "check" ? (
                  <li key={`rw-${x.i}`} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2">
                    <Event plain at={when(x.at)}>
                      <Quoted text={t("workflows.ask.checkSentBack", { step: stepTitle })} />
                    </Event>
                    <p className="text-ink-soft bg-rose-wash/40 ring-rose-text/15 m-0 max-w-[40rem] justify-self-center whitespace-pre-wrap break-words rounded-xl px-3.5 py-2.5 text-[13px]/5 ring-1 ring-inset">
                      {x.note}
                    </p>
                  </li>
                ) : (
                  <li key={`rw-${x.i}`}>
                    <Reply who={dir.name(x.by)} label={t("workflows.ask.reworkAsked", { step: stepTitle })} at={when(x.at)}>
                      {x.note}
                    </Reply>
                  </li>
                );
              return (
                <li key={`ap-${x.i}`} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2">
                  <Event at={x.at ? when(x.at) : undefined}>
                    <Quoted text={t("workflows.ask.approvedStep", { step: stepTitle })} />
                  </Event>
                  {x.note ? <Reply label={t("workflows.ask.noteGiven")}>{x.note}</Reply> : null}
                </li>
              );
            })}
            {tail}
          </ol>
          {failed ? <LoadFailed what={t("workflows.ask.title")} onRetry={() => void load()} /> : null}
        </main>
      </div>
      {dock ? (
        <div className="shrink-0">
          <div className={cx(wrap, "pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-1")}>{dock}</div>
        </div>
      ) : null}
    </div>
  );
}
