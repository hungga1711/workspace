"use client";

import dynamic from "next/dynamic";
import type { MentionAnswer, PendingCard, Source, ToolChip } from "@/components/ai/mention-types";
import { actionsFor, readBlocks, type AnswerBlock } from "@/components/ai/answer/types";
import { composeInto } from "./compose";
import { BotIcon, CloseIcon, CopyIcon, EyeOffIcon, RefreshIcon } from "@/components/app/icons";
import { aiProblem } from "@/lib/ai-spend";
import { api } from "@/lib/client";
import { useFormat } from "@/lib/i18n/client";
import { cx, skeleton } from "@/lib/ui";
import { ToolBtn } from "./MessageItem";
import { RichText } from "./RichText";

// What surrounds an AI answer (what it did and read, a change to confirm) loads with the first @AI of the visit.
const MentionSteps = dynamic(() => import("@/components/ai/MentionExtras").then((m) => m.MentionSteps), { ssr: false });
const MentionExtras = dynamic(() => import("@/components/ai/MentionExtras").then((m) => m.MentionExtras), { ssr: false });
// The proposal card (and its pickers) loads when someone asks for a task.
const TaskProposal = dynamic(() => import("@/components/workflows/TaskProposal").then((m) => m.TaskProposal), { ssr: false });
// Charts and tables of the data the answer read, loaded with the first answer that has one.
const AnswerExtras = dynamic(() => import("@/components/ai/answer/AnswerExtras"), { ssr: false });
// Notes on how it was answered and what to ask or do next, with the first answer that has any.
const AnswerNotes = dynamic(() => import("@/components/ai/AnswerProgress").then((m) => m.AnswerNotes), { ssr: false });
const NextSteps = dynamic(() => import("@/components/ai/answer/NextSteps").then((m) => m.NextSteps), { ssr: false });

/** A private @AI / @Agent exchange, shown inline in the log for this visit only (never stored in the channel). */
export interface AiTurn {
  id: string;
  agent: { id: string; name: string } | null;
  question: string;
  answer: string | null;
  error: string | null;
  /** "@AI tạo task …": the AI drafts a task (and its agent workflow) instead of answering. */
  propose?: boolean;
  /** What the AI did and read for this answer, and a change waiting for the asker's yes (ai/mention). */
  tools?: ToolChip[];
  sources?: Source[];
  blocks?: AnswerBlock[];
  notes?: string[];
  followUps?: string[];
  confirm?: PendingCard;
  deciding?: boolean;
}
export const rid = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
/** An answer from the assistant as the turn shows it; a change waiting for a yes may come with no text yet. */
export const answered = (r: MentionAnswer): Partial<AiTurn> => ({
  answer: r.answer ?? "",
  tools: r.toolCalls ?? [],
  sources: r.sources ?? [],
  blocks: readBlocks(r.blocks),
  notes: Array.isArray(r.notes) ? r.notes.filter((x) => typeof x === "string") : [],
  followUps: Array.isArray(r.followUps) ? r.followUps.filter((x) => typeof x === "string") : [],
  confirm: r.pending,
  error: null,
});

type T = ReturnType<typeof useFormat>["t"];

/** Asks the assistant where the person is (a channel, or one of its threads); the answer is theirs alone. */
export const askMention = (channelId: string, content: string, threadId?: string) =>
  api<MentionAnswer>("ai/mention", { method: "POST", body: { surface: "channel", channelId, content, ...(threadId ? { threadId } : {}) } });

/**
 * The asker's answer to a confirm card: the change runs (or not) and the answer carries on; another card may follow.
 * Returns what changes on the turn (the steps of both halves of the answer stay listed).
 */
export async function decideMention(turn: AiTurn, approve: boolean, t: T): Promise<Partial<AiTurn>> {
  if (!turn.confirm) return {};
  try {
    const r = await api<MentionAnswer>(`ai/assistant/pending/${turn.confirm.id}`, { method: "POST", body: { approve } });
    return { ...answered(r), tools: [...(turn.tools ?? []), ...(r.toolCalls ?? [])], deciding: false };
  } catch (e) {
    const err = e as { status?: number };
    if (err.status === 404) return { answer: t("mcpClient.chat.expired"), confirm: undefined, deciding: false };
    return { deciding: false, error: aiProblem(t, err) ?? t("chat.ai.failed") };
  }
}

/** A private question/answer pair. Same ink and type as people's messages (DESIGN.md: AI has no visual identity). */
export function AiTurnView({
  turn,
  me,
  names,
  onRetry,
  onDecide,
  onCopy,
  onHide,
  composerId = "composer",
}: {
  /** The box a follow-up goes into: the channel's ("composer") or a thread's ("thread-reply"). */
  composerId?: string;
  turn: AiTurn;
  onDecide?: ((approve: boolean) => void | Promise<unknown>) | undefined;
  me: string;
  names: Record<string, string>;
  onRetry: () => void;
  onCopy: (answer: string) => void;
  onHide: () => void;
}) {
  const { t } = useFormat();
  const title = turn.agent?.name ?? "AI";
  // A follow-up goes into the box as a question to the AI there; it is never sent by itself.
  const compose = (text: string) => composeInto(composerId, `@${turn.agent?.name ?? "AI"} ${text}`);
  return (
    <section className="border-hairline bg-surface rounded-xl border py-2" aria-label={t("chat.ai.privateOf", { name: title })} aria-busy={!turn.answer && !turn.error}>
      <p className="text-ink-2 flex items-center gap-1.5 px-3 pb-1 text-xs">
        <EyeOffIcon className="size-3.5" />
        {t("chat.ai.private")}
      </p>
      <div className="flex justify-end px-3 py-1">
        <p className="bg-hover max-w-[80%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm/[1.5] [overflow-wrap:anywhere]">
          {turn.question || <em className="text-ink-2">{t("chat.ai.noQuestion")}</em>}
        </p>
      </div>
      <div className="grid grid-cols-[36px_minmax(0,1fr)] gap-x-3 px-3 pt-1.5">
        <span className="bg-surface text-ink-2 ring-hairline grid size-9 place-items-center rounded-lg ring-1">
          <BotIcon className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold">{title}</p>
          {turn.propose ? (
            <div className="pt-1">
              <TaskProposal text={turn.question} />
            </div>
          ) : turn.error && !turn.confirm ? (
            <p className="text-block text-sm" role="alert">
              {turn.error}{" "}
              <button type="button" className="underline" onClick={onRetry}>
                {t("common.retry")}
              </button>
            </p>
          ) : turn.answer === null ? (
            <div className="grid gap-2 pt-1" role="status">
              <span className="text-ink-2 text-sm">{t("chat.ai.answering")}</span>
              <span className={skeleton} />
              <span className={cx(skeleton, "w-2/3")} />
            </div>
          ) : (
            <>
              <MentionSteps tools={turn.tools} />
              {turn.answer ? (
                <div className="whitespace-pre-wrap text-sm/[1.6] [overflow-wrap:anywhere]">
                  <RichText text={turn.answer} names={names} me={me} />
                </div>
              ) : null}
              {turn.blocks?.length ? <AnswerExtras blocks={turn.blocks} cards={[]} onAsk={compose} /> : null}
              <MentionExtras sources={turn.sources} confirm={turn.confirm} onDecide={onDecide} />
              {turn.notes?.length ? <AnswerNotes notes={turn.notes} /> : null}
              {!turn.confirm && (turn.followUps?.length || actionsFor(turn.tools).length) ? <NextSteps tools={turn.tools} followUps={turn.followUps} onPick={compose} /> : null}
              {turn.error ? (
                <p className="text-block m-0 mt-1 text-sm" role="alert">
                  {turn.error}
                </p>
              ) : null}
              <div className="-ml-1.5 mt-1 flex items-center gap-0.5">
                {/* While a change waits for a yes there is no answer to copy, and asking again would leave the card behind. */}
                {turn.answer ? (
                  <ToolBtn label={t("chat.ai.copy")} onClick={() => onCopy(turn.answer!)}>
                    <CopyIcon />
                  </ToolBtn>
                ) : null}
                {turn.confirm ? null : (
                  <ToolBtn label={t("chat.ai.regenerate")} onClick={onRetry}>
                    <RefreshIcon />
                  </ToolBtn>
                )}
                <ToolBtn label={t("chat.ai.hide")} onClick={onHide}>
                  <CloseIcon />
                </ToolBtn>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
