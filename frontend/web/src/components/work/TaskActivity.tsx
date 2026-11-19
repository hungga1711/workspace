"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { budgetMessage } from "@/lib/ai-spend";
import { useFormat, useT } from "@/lib/i18n/client";
import { useDirectory } from "@/lib/people";
import { btn, btnGhost, btnSm, cx } from "@/lib/ui";
import { BotIcon, ChatIcon, ClockIcon, LinkIcon } from "@/components/app/icons";
import { Markdown } from "@/lib/markdown";
import type { MentionAnswer, PendingCard, Source, ToolChip } from "@/components/ai/mention-types";
import type { Attachment } from "@/components/chat/attachments";
import { PersonTrigger } from "@/components/chat/PersonTrigger";
import { ActivityRow, activityList } from "@/components/comments/ActivityRow";
import { CommentComposer } from "@/components/comments/CommentComposer";
import { CommentThread } from "@/components/comments/CommentThread";
import type { TaskDetail } from "@/app/app/work/tasks/[id]/page";

// What surrounds an AI answer (what it did and read, a change to confirm) loads with the first "@AI" comment.
const MentionSteps = dynamic(() => import("@/components/ai/MentionExtras").then((m) => m.MentionSteps), { ssr: false });
const MentionExtras = dynamic(() => import("@/components/ai/MentionExtras").then((m) => m.MentionExtras), { ssr: false });

/** A comment that calls the AI: "@AI" at its start or after a space (never inside an e-mail address). */
const AI_MENTION = /(^|\s)@ai(?![\p{L}\p{N}_-])/iu;
export const mentionsAi = (body: string) => AI_MENTION.test(body);

/**
 * The AI's turn after a comment mentioned it. Its answer becomes a comment on the task (everyone there reads it);
 * until then only the asker sees this: that it is working, a change it wants to make, or that it failed.
 */
interface AiTurn {
  question: string;
  state: "working" | "confirm" | "deciding" | "failed";
  answer?: string;
  tools?: ToolChip[];
  sources?: Source[];
  confirm?: PendingCard;
  error?: string;
}

const TaskRelated = dynamic(() => import("./TaskRelated"), { ssr: false, loading: () => <p className="text-ink-2 m-0 py-3 text-sm">…</p> });

type Comment = TaskDetail["comments"][number];
type Change = TaskDetail["activity"][number];
type Pane = "comments" | "history" | "related";

/** The tab a viewer last chose, kept on this device only. */
const TAB_KEY = "wos:task-activity-tab";

/**
 * The task's conversation card: tabs for Bình luận, Lịch sử and Liên quan in its header, the
 * last one chosen kept per viewer. Comments read oldest first like a chat with the composer docked under them; Lịch sử
 * is every change as a log grouped by day. Hỏi AI is not a tab here: it is the person's private chat, not the task's
 * record, so it opens from the button by the title (TaskAskSheet).
 */
export function TaskActivity({
  taskId,
  code,
  comments,
  activity,
  describe,
  onAdd,
  onEdit,
  onDelete,
  onUpload,
  ai = false,
  onAiComment,
}: {
  /** The company's AI is on: "@AI" in a comment asks it, and it answers as a comment. */
  ai?: boolean;
  /** The AI's answer was posted on the task as this comment. */
  onAiComment?: (id: string, body: string) => void;
  taskId: string;
  code: string;
  comments: Comment[];
  activity: Change[];
  /** What a change says ("moved from … to …"), from the task screen that knows the fields. */
  describe: (a: Change) => string;
  onAdd: (text: string, attachments?: Attachment[]) => Promise<void>;
  onEdit: (id: string, body: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onUpload: (file: File) => Promise<Attachment>;
}) {
  const t = useT();
  const { dayLabel } = useFormat();
  const dir = useDirectory();
  const [pane, setPaneState] = useState<Pane>("comments");
  // Read after mount (the server renders the default): storage can be blocked or empty, and that is fine.
  useEffect(() => {
    try {
      const v = window.localStorage.getItem(TAB_KEY) as Pane | null;
      // Anything else (the old "ai" tab, before Hỏi AI moved by the title) keeps the default.
      if (v === "history" || v === "comments" || v === "related") setPaneState(v);
    } catch {
      /* no storage: the default tab */
    }
  }, []);
  const setPane = (v: Pane) => {
    setPaneState(v);
    try {
      window.localStorage.setItem(TAB_KEY, v);
    } catch {
      /* not remembered */
    }
  };
  const actorId = (actor: string) => actor.replace(/^(user|agent|service):/, "");

  const [turn, setTurn] = useState<AiTurn | null>(null);
  /** The assistant's reply to a mention or to a decision: posted as a comment, another change to confirm, or neither. */
  const took = (question: string, r: MentionAnswer, before: ToolChip[] = []) => {
    if (r.posted) {
      onAiComment?.(r.posted.commentId, r.answer);
      setTurn(null);
    } else if (r.pending) setTurn({ question, state: "confirm", answer: r.answer, tools: [...before, ...(r.toolCalls ?? [])], sources: r.sources ?? [], confirm: r.pending });
    // Nothing posted and nothing to confirm (an older server): the answer still shows, to the asker only.
    else setTurn({ question, state: "failed", answer: r.answer, tools: r.toolCalls ?? [], sources: r.sources ?? [] });
  };
  const failure = (e: unknown) => {
    const err = e as { status?: number; body?: { error?: string } };
    return budgetMessage(t, err) ?? t(err.body?.error === "ai_unavailable" || err.status === 503 ? "aiMention.unavailable" : "aiMention.failed");
  };
  /** Asks the AI what the comment asked. The person's comment is already posted: a failure here never loses it. */
  const askAi = async (question: string) => {
    setTurn({ question, state: "working" });
    try {
      took(question, await api<MentionAnswer>("ai/mention", { method: "POST", body: { surface: "task", taskId, content: question } }));
    } catch (e) {
      setTurn({ question, state: "failed", error: failure(e) });
    }
  };
  const decide = async (approve: boolean) => {
    const cur = turn;
    if (!cur?.confirm) return;
    setTurn({ ...cur, state: "deciding" });
    try {
      took(cur.question, await api<MentionAnswer>(`ai/assistant/pending/${cur.confirm.id}`, { method: "POST", body: { approve } }), cur.tools);
    } catch (e) {
      const gone = (e as { status?: number }).status === 404;
      setTurn(gone ? { question: cur.question, state: "failed", error: t("mcpClient.chat.expired") } : { ...cur, state: "confirm", error: failure(e) });
    }
  };
  const submit = async (body: string, attachments: Attachment[] = []) => {
    await onAdd(body, attachments);
    if (ai && mentionsAi(body)) void askAi(body.replace(AI_MENTION, "$1").trim() || body);
  };

  const changes = activity.filter((a) => a.action !== "commented" && a.action !== "comment_edited").sort((x, y) => new Date(y.at).getTime() - new Date(x.at).getTime());
  const tabs: { key: Pane; label: string; icon: React.ReactNode; count?: number }[] = [
    { key: "comments", label: t("work.taskdetailview.act_comments"), icon: <ChatIcon />, count: comments.length },
    { key: "history", label: t("taskChat.tabHistory"), icon: <ClockIcon />, count: changes.length },
    { key: "related", label: t("taskChat.tabRelated"), icon: <LinkIcon /> },
  ];

  // Lịch sử: newest first, under a label per day; each change says who (the AI for its own questions), what, when.
  const days: { day: string; items: Change[] }[] = [];
  for (const a of changes) {
    const day = dayLabel(a.at);
    if (days.at(-1)?.day === day) days.at(-1)!.items.push(a);
    else days.push({ day, items: [a] });
  }
  const history = changes.length ? (
    <div className="grid gap-5">
      {days.map((d) => (
        <section key={d.day} aria-label={d.day}>
          <h3 className="text-ink-2 m-0 mb-1.5 text-xs font-medium" suppressHydrationWarning>
            {d.day}
          </h3>
          <ol className={activityList}>
            {d.items.map((a, i) => {
              const ai = a.action === "agent_run_asked" || a.actor.startsWith("agent:");
              const who = actorId(a.actor);
              return (
                <ActivityRow key={`${a.at}-${a.action}-${i}`} who={who} ai={ai} at={a.at}>
                  {/* "The AI asked 2 questions…" names the AI itself; other rows lead with who did it. */}
                  {a.action === "agent_run_asked" ? null : (
                    <>
                      {ai ? (
                        <span className="text-ink font-medium">{t("taskChat.aiName")}</span>
                      ) : (
                        <PersonTrigger userId={who} className="text-ink inline rounded-sm font-medium hover:underline">
                          {dir.name(who)}
                        </PersonTrigger>
                      )}{" "}
                    </>
                  )}
                  {describe(a)}
                </ActivityRow>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  ) : (
    <p className="text-ink-2 m-0 py-2 text-[13px]">{t("taskChat.noHistory")}</p>
  );

  return (
    <section className="bg-surface shadow-card mt-7 min-w-0 rounded-xl" aria-labelledby="cmt-h">
      <h2 id="cmt-h" className="sr-only">
        {t("taskChat.tabs")}
      </h2>
      <header className="border-hairline flex min-h-12 items-center gap-1 border-b px-3 sm:px-4">
        <div role="tablist" aria-labelledby="cmt-h" className="no-scrollbar -mx-1 flex min-w-0 items-center gap-0.5 overflow-x-auto px-1">
          {tabs.map((x) => (
            <button
              key={x.key}
              type="button"
              role="tab"
              aria-selected={pane === x.key}
              onClick={() => setPane(x.key)}
              className={cx(
                "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium transition-colors max-[400px]:px-1.5 [&_svg]:size-3.5 max-[400px]:[&_svg]:hidden",
                pane === x.key ? "bg-hover text-ink" : "text-ink-2 hover:text-ink hover:bg-hover/60",
              )}
            >
              {x.icon}
              {x.label}
              {x.count ? <span className="text-ink-2 font-normal tabular-nums">{x.count}</span> : null}
            </button>
          ))}
        </div>
      </header>
      {pane === "history" ? (
        <div className="px-4 py-4 sm:px-5">{history}</div>
      ) : pane === "related" ? (
        <div className="px-4 py-4 sm:px-5">
          <TaskRelated taskId={taskId} code={code} />
        </div>
      ) : (
        <>
          <div className="px-4 pb-2 pt-3 sm:px-5">
            {comments.length ? <CommentThread comments={comments} onEdit={onEdit} onDelete={onDelete} /> : null}
            {comments.length ? null : <p className="text-ink-2 m-0 py-2 text-[13px]">{t("work.taskdetailview.act_noComments")}</p>}
            {turn ? (
              <div
                className="border-hairline bg-ground/50 mt-3 grid min-w-0 grid-cols-[1.75rem_minmax(0,1fr)] gap-x-2.5 rounded-xl border p-3"
                aria-live="polite"
                aria-busy={turn.state === "working" || turn.state === "deciding"}
              >
                <span className="bg-surface text-ink-2 ring-hairline grid size-7 place-items-center rounded-lg ring-1">
                  <BotIcon className={cx("size-4", (turn.state === "working" || turn.state === "deciding") && "motion-safe:animate-pulse")} />
                </span>
                <div className="min-w-0 text-sm">
                  <p className="text-ink-2 m-0 text-xs">{t("aiMention.onlyYou")}</p>
                  {turn.state === "working" ? (
                    <p className="text-ink-soft m-0 mt-1" role="status">
                      {t("aiMention.working")}
                    </p>
                  ) : (
                    <>
                      <div className="mt-1">
                        <MentionSteps tools={turn.tools} />
                      </div>
                      {turn.answer ? (
                        <div className="text-ink [overflow-wrap:anywhere] [&_p]:my-1.5">
                          <Markdown source={turn.answer} />
                        </div>
                      ) : null}
                      <MentionExtras sources={turn.sources} confirm={turn.confirm} onDecide={turn.state === "confirm" ? (approve) => decide(approve) : undefined} />
                      {turn.error ? (
                        <p className="text-block m-0 mt-1.5" role="alert">
                          {turn.error}
                        </p>
                      ) : null}
                      {turn.state === "failed" ? (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {turn.error ? (
                            <button type="button" className={cx(btn, btnSm)} onClick={() => void askAi(turn.question)}>
                              {t("common.retry")}
                            </button>
                          ) : null}
                          <button type="button" className={cx(btnGhost, btnSm)} onClick={() => setTurn(null)}>
                            {t("aiMention.dismiss")}
                          </button>
                        </div>
                      ) : null}
                    </>
                  )}
                </div>
              </div>
            ) : null}
          </div>
          {/* The chat composer in its comment form: @ suggests colleagues (they are notified), Enter or the button posts,
              Shift+Enter adds a line; an unsent comment is kept per task until posted. */}
          <div className="border-hairline bg-ground/40 rounded-b-xl border-t px-3 py-3 sm:px-4">
            <CommentComposer
              id="task-comment"
              draftKey={`task-comment:${taskId}`}
              label={t("work.taskdetailview.binh_luan")}
              placeholder={t("work.taskdetailview.viet_binh_luan_go")}
              onUpload={onUpload}
              ai={ai}
              onSubmit={(body, attachments) => void submit(body, attachments)}
            />
          </div>
        </>
      )}
    </section>
  );
}
