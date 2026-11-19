"use client";

import { aiProblem, budgetMessage } from "@/lib/ai-spend";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/client";
import { useAiEnabled } from "@/lib/ai-context";
import { formatMentions } from "@/lib/names";
import { type LinkPreview } from "./LinkPreviews";
import { MessageItem } from "./MessageItem";
import { useFormat } from "@/lib/i18n/client";
import { useDirectory } from "@/lib/people";
import { btn, btnGhost, btnSm, cx, skeleton } from "@/lib/ui";
import { CheckIcon, CloseIcon, CopyIcon, FlagIcon, CheckCircleIcon, LinkIcon, PencilIcon, PinIcon, SparkleIcon, TrashIcon } from "@/components/app/icons";
import { Drawer, drawerTool } from "@/components/ui/Drawer";
import type { Message } from "./Conversation";
import { uploadChatFile, type Attachment } from "./attachments";
import { AiTurnView, answered, askMention, decideMention, rid, type AiTurn } from "./AiTurn";
import { Composer } from "./Composer";
import { ThreadLinks, type ThreadLink } from "./ThreadLinks";

interface Proposals {
  summary: string;
  actions: { title: string; assigneeId: string | null; due: string | null }[];
  decisions: { title: string }[];
}

/**
 * Thread as a first-class object: replies, AI summary, proposed tasks
 * and decisions with traceability back to this thread. AI only proposes; a person confirms each item.
 * Opens in the shared side drawer over the conversation; the reply composer stays pinned at its foot. On wide screens
 * (`docked`) it is a pane beside the conversation instead, so the channel stays readable and usable while replying.
 */
export function ThreadPanel({
  rootId,
  channelId,
  me,
  autoSummarize = false,
  onClose,
  incoming = null,
  previews = null,
  docked = false,
  canReply = true,
}: {
  rootId: string;
  channelId: string;
  me: string;
  autoSummarize?: boolean;
  onClose: () => void;
  incoming?: Message | null;
  /** Link previews that arrived for a message (the root or a reply). */
  previews?: { messageId: string; linkPreviews: LinkPreview[] } | null;
  docked?: boolean;
  /** False while the viewer is not a member of the channel. */
  canReply?: boolean;
}) {
  const dir = useDirectory();
  const { t, time, dayLabel } = useFormat();
  // A thread can be years old: past today, a message's time carries its day too.
  const stamp = (iso: string) => (dayLabel(iso) === dayLabel(new Date()) ? time(iso) : `${dayLabel(iso)} ${time(iso)}`);
  const names = dir.names;
  const [root, setRoot] = useState<Message | null>(null);
  const [replies, setReplies] = useState<Message[]>([]);
  const [ai, setAi] = useState<{ state: "idle" | "loading" | "error" | "quota" | "ready"; data?: Proposals }>({ state: "idle" });
  // The summary appears below the replies; bring it into view when it starts and when it is ready.
  const aiRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (ai.state !== "idle") aiRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [ai.state]);
  const [created, setCreated] = useState<Record<string, { label: string; href?: string }>>({});
  const [error, setError] = useState<string | null>(null);

  const aiOn = useAiEnabled();
  const [links, setLinks] = useState<ThreadLink[]>([]);
  const load = () =>
    api<{ root: Message; replies: Message[]; links?: ThreadLink[] }>(`chat/messages/${rootId}/thread`)
      .then((t) => {
        setRoot(t.root);
        setReplies(t.replies);
        setLinks(t.links ?? []);
      })
      .catch(() => setError(t("chat.thread.loadError")));
  useEffect(() => {
    void load();
  }, [rootId]); // eslint-disable-line react-hooks/exhaustive-deps
  // Live replies from others arrive through the conversation's socket; dedupe by id / clientMsgId.
  useEffect(() => {
    if (!incoming || incoming.threadRootId !== rootId) return;
    setReplies((r) => (r.some((x) => x.id === incoming.id || (incoming.clientMsgId && x.clientMsgId === incoming.clientMsgId)) ? r : [...r, incoming]));
  }, [incoming, rootId]);
  useEffect(() => {
    if (!previews) return;
    const put = (m: Message) => (m.id === previews.messageId ? { ...m, linkPreviews: previews.linkPreviews } : m);
    setRoot((r) => (r ? put(r) : r));
    setReplies((r) => r.map(put));
  }, [previews]);

  // "@AI …" in a reply asks the assistant about this thread; the exchange is the asker's alone, for this visit only.
  const [aiTurns, setAiTurns] = useState<AiTurn[]>([]);
  const turnsRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (aiTurns.length) turnsRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [aiTurns]);
  const patchTurn = (id: string, p: Partial<AiTurn>) => setAiTurns((cur) => cur.map((x) => (x.id === id ? { ...x, ...p } : x)));
  const ask = async (turn: AiTurn) => {
    setAiTurns((cur) => [...cur.filter((x) => x.id !== turn.id), { id: turn.id, agent: null, question: turn.question, answer: null, error: null }]);
    try {
      patchTurn(turn.id, answered(await askMention(channelId, turn.question, rootId)));
    } catch (e) {
      patchTurn(turn.id, { error: aiProblem(t, e) ?? t("chat.ai.failed") });
    }
  };
  const decideTurn = async (turn: AiTurn, approve: boolean) => {
    patchTurn(turn.id, { deciding: true, error: null });
    patchTurn(turn.id, await decideMention(turn, approve, t));
  };

  const reply = async (body: string, files: Attachment[] = []) => {
    if (aiOn && !files.length && /^@ai\s+\S/i.test(body)) {
      try {
        localStorage.setItem("wos_tried_ai", "1");
      } catch {
        /* ignore */
      }
      void ask({ id: rid(), agent: null, question: body.replace(/^@ai\s+/i, "").trim(), answer: null, error: null });
      return;
    }
    try {
      const m = await api<Message>(`chat/channels/${channelId}/messages`, {
        method: "POST",
        body: { body, attachments: files.map((f) => f.fileId), threadRootId: rootId, clientMsgId: `t${Date.now()}${Math.random().toString(36).slice(2, 8)}` },
      });
      setReplies((r) => (r.some((x) => x.id === m.id) ? r : [...r, m])); // realtime may have delivered it first
    } catch {
      setError(t("chat.thread.replyFailed"));
    }
  };

  const summarize = async () => {
    if (!aiOn) return;
    setAi({ state: "loading" });
    try {
      localStorage.setItem("wos_tried_ai", "1");
    } catch {
      /* ignore */
    }
    try {
      setAi({ state: "ready", data: await api<Proposals>(`ai/threads/${rootId}/summarize`, { method: "POST" }) });
    } catch (e) {
      setAi({ state: budgetMessage(t, e) ? "quota" : "error" });
    }
  };
  useEffect(() => {
    if (autoSummarize) void summarize();
  }, [autoSummarize]); // eslint-disable-line react-hooks/exhaustive-deps

  const source = { type: "chat.message", messageId: rootId, channelId };
  const createTask = async (a: Proposals["actions"][number]) => {
    const task = await api<{ id: string; code: string }>("work/tasks", { method: "POST", body: { title: a.title, assigneeId: a.assigneeId, source } });
    setCreated((c) => ({ ...c, [a.title]: { label: t("chat.thread.createdTask", { code: task.code }), href: `/app/work/tasks/${task.id}` } }));
  };

  // The same actions as in the channel, on the thread's own copies of its messages.
  const put = (r: Message) => {
    setRoot((x) => (x?.id === r.id ? { ...x, ...r } : x));
    setReplies((xs) => xs.map((x) => (x.id === r.id ? { ...x, ...r } : x)));
  };
  const flag = (m: Message, k: "saved" | "pinned", on: boolean) => put({ ...m, [k]: on });
  const [editing, setEditing] = useState<string | null>(null);
  const [picker, setPicker] = useState<string | null>(null);
  const failed = () => setError(t("common.actionFailed"));
  const toggle = (m: Message, k: "saved" | "pinned", path: string) => {
    const on = !m[k];
    flag(m, k, on);
    void api(`chat/messages/${m.id}/${path}`, { method: on ? "POST" : "DELETE" }).catch(() => {
      flag(m, k, !on);
      failed();
    });
  };
  const moreItems = (m: Message) => [
    { label: t(m.pinned ? "chat.conv.unpin" : "chat.conv.pin"), icon: <PinIcon className="size-4" />, onSelect: () => toggle(m, "pinned", "pin") },
    {
      label: t("chat.conv.copyLink"),
      icon: <LinkIcon className="size-4" />,
      onSelect: () => void navigator.clipboard.writeText(`${window.location.origin}/app/chat/m/${m.id}`).catch(failed),
    },
    ...(m.authorId === me && m.authorType === "user"
      ? [
          { label: t("common.edit"), icon: <PencilIcon className="size-4" />, onSelect: () => setEditing(m.id) },
          {
            label: t("common.delete"),
            icon: <TrashIcon className="size-4" />,
            danger: true,
            onSelect: () => {
              if (!window.confirm(t("chat.conv.confirmDelete"))) return;
              void api(`chat/messages/${m.id}`, { method: "DELETE" })
                .then(() => put({ ...m, body: "", deletedAt: new Date().toISOString() }))
                .catch(failed);
            },
          },
        ]
      : []),
  ];
  const msg = (m: Message) => (
    <MessageItem
      key={m.id}
      m={m}
      me={me}
      stamp={stamp}
      className="mx-1 px-3"
      tone={m.mentions.includes(me) && m.authorId !== me ? "mentioned" : "default"}
      editing={editing === m.id}
      onCancelEdit={() => setEditing(null)}
      onSaveEdit={(body) =>
        void api<Message>(`chat/messages/${m.id}`, { method: "PATCH", body: { body } })
          .then((r) => {
            put(r);
            setEditing(null);
          })
          .catch(failed)
      }
      picker={picker === m.id}
      onPicker={(open) => setPicker(open ? m.id : null)}
      onReact={(emoji) => void api<Message>(`chat/messages/${m.id}/reactions`, { method: "POST", body: { emoji } }).then(put).catch(failed)}
      onSave={() => toggle(m, "saved", "save")}
      moreItems={moreItems(m)}
      onPoll={(poll) => put({ ...m, poll })}
    />
  );
  const done = (key: string) =>
    created[key] ? (
      created[key]!.href ? (
        <Link href={created[key]!.href!} className="text-ok text-xs font-medium">
          {created[key]!.label}
        </Link>
      ) : (
        <span className="text-ok text-xs font-medium">{created[key]!.label}</span>
      )
    ) : null;

  return (
    <ThreadFrame
      docked={docked}
      rootId={rootId}
      onClose={onClose}
      actions={
        aiOn ? (
          <button type="button" className={cx(btnGhost, btnSm, "text-accent-text mr-1")} onClick={() => void summarize()} disabled={ai.state === "loading"}>
            <SparkleIcon />
            {t("chat.thread.summarize")}
          </button>
        ) : null
      }
      footer={
        // Reading a channel one hasn't joined: replies need joining first (the bar under the conversation offers it).
        canReply ? (
          <Composer
            id="thread-reply"
            label={t("chat.thread.reply")}
            placeholder={t("chat.thread.replyPlaceholder")}
            draftKey={`t:${rootId}`}
            candidates={[
              ...dir.people.filter((p) => p.userId !== me).map((p) => ({ id: p.userId, name: p.displayName })),
              ...(aiOn ? [{ id: "ai", name: "AI", agent: true }] : []),
            ]}
            onSubmit={(b, files) => void reply(b, files)}
            onUpload={(file) => uploadChatFile(channelId, file)}
          />
        ) : null
      }
    >
      <div>
        {error ? (
          <p className="text-block px-4 py-2 text-sm" role="alert">
            {error}
          </p>
        ) : null}
        {root ? <ThreadLinks rootId={rootId} links={links} texts={[root.body, ...replies.map((r) => r.body)]} onChange={setLinks} /> : null}
        {root ? (
          msg(root)
        ) : (
          <div className="grid gap-2 p-4">
            <span className={skeleton} />
            <span className={cx(skeleton, "w-3/4")} />
          </div>
        )}
        {replies.length > 0 ? (
          <div className="flex items-center gap-3 px-4 py-1">
            <span className="text-ink-2 text-xs">{t("chat.thread.replies", { count: replies.length })}</span>
            <span className="bg-hairline h-px flex-1" />
          </div>
        ) : null}
        {replies.map(msg)}
        {aiTurns.length ? (
          <div ref={turnsRef} className="grid scroll-mb-4 gap-3 px-4 py-3">
            {aiTurns.map((x) => (
              <AiTurnView
                key={x.id}
                composerId="thread-reply"
                turn={x}
                me={me}
                names={names}
                onRetry={() => void ask(x)}
                onDecide={x.confirm && !x.deciding ? (approve) => decideTurn(x, approve) : undefined}
                onCopy={(a) => void navigator.clipboard?.writeText(a).catch(() => {})}
                onHide={() => setAiTurns((cur) => cur.filter((y) => y.id !== x.id))}
              />
            ))}
          </div>
        ) : null}

        {ai.state !== "idle" ? (
          <section ref={aiRef} className="border-hairline bg-ground mx-4 my-3 scroll-mb-4 rounded-xl border p-3.5 text-sm" aria-live="polite" aria-busy={ai.state === "loading"}>
            {ai.state === "loading" ? (
              <div className="grid grid-cols-1 gap-2">
                <span className="text-ink-2">{t("chat.thread.reading")}</span>
                <span className={skeleton} />
                <span className={cx(skeleton, "w-2/3")} />
              </div>
            ) : null}
            {ai.state === "error" ? (
              <p>
                {t("chat.thread.summaryFailed")}{" "}
                <button type="button" className="text-brand-text underline" onClick={() => void summarize()}>
                  {t("common.retry")}
                </button>{" "}
                {t("chat.thread.or")} <Link href="/app/work/tasks?new=task">{t("chat.thread.manualTask")}</Link>.
              </p>
            ) : null}
            {ai.state === "quota" ? (
              <p>
                {t("chat.thread.quota")} <Link href="/app/work/tasks?new=task">{t("chat.thread.manualTask")}</Link>.
              </p>
            ) : null}
            {ai.state === "ready" && ai.data ? (
              <div className="grid grid-cols-1 gap-3">
                <div>
                  <p className="text-ink-2 mb-1 text-xs font-semibold">{t("chat.thread.summary")}</p>
                  <p className="leading-snug">{formatMentions(ai.data.summary, names)}</p>
                </div>
                {ai.data.decisions.length ? (
                  <div>
                    <p className="text-ink-2 mb-1 text-xs font-semibold">{t("chat.thread.decisions")}</p>
                    <ul className="m-0 grid list-none gap-1.5 p-0">
                      {ai.data.decisions.map((d) => (
                        <li key={d.title} className="flex items-start gap-2">
                          <FlagIcon className="text-ink-2 mt-0.5 size-4 shrink-0" />
                          <span className="flex-1 leading-snug">{formatMentions(d.title, names)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {ai.data.actions.length ? (
                  <div>
                    <p className="text-ink-2 mb-1 text-xs font-semibold">{t("chat.thread.actions")}</p>
                    <ul className="m-0 grid list-none gap-1.5 p-0">
                      {ai.data.actions.map((a) => (
                        <li key={a.title} className="flex items-start gap-2">
                          <CheckCircleIcon className="text-ink-2 mt-0.5 size-4 shrink-0" />
                          <span className="flex-1 leading-snug">
                            {formatMentions(a.title, names)}
                            {a.assigneeId || a.due ? (
                              <span className="text-ink-2 block text-xs">
                                {a.assigneeId ? `→ ${dir.name(a.assigneeId)}` : ""}
                                {a.due ? t("chat.thread.due", { date: a.due }) : ""}
                              </span>
                            ) : null}
                          </span>
                          {done(a.title) ?? (
                            <button type="button" className={cx(btn, btnSm)} onClick={() => void createTask(a)}>
                              {t("chat.thread.createTask")}
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {!ai.data.actions.length && !ai.data.decisions.length ? <p className="text-ink-2">{t("chat.thread.nothingFound")}</p> : null}
                <p className="text-ink-2 flex items-center gap-1 text-xs">
                  <CheckIcon className="size-3.5" />
                  {t("chat.thread.aiOnlySuggests")}
                </p>
              </div>
            ) : null}
          </section>
        ) : null}
      </div>
    </ThreadFrame>
  );
}

/** The thread's frame: the side drawer, or (`docked`) a pane in the conversation's row with the same header. */
function ThreadFrame({
  docked,
  rootId,
  onClose,
  actions,
  footer,
  children,
}: {
  docked: boolean;
  rootId: string;
  onClose: () => void;
  actions: React.ReactNode;
  footer: React.ReactNode;
  children: React.ReactNode;
}) {
  const { t } = useFormat();
  const [copied, setCopied] = useState(false);
  if (!docked)
    return (
      <Drawer title={t("chat.thread.title")} label={t("chat.thread.title")} onClose={onClose} copy={`/app/chat/m/${rootId}`} actions={actions} footer={footer}>
        {/* The ask panel (⌘J) reads which thread is open: "this thread" then means it. */}
        <span hidden data-ask-thread={rootId} />
        {children}
      </Drawer>
    );
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(new URL(`/app/chat/m/${rootId}`, window.location.origin).toString());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  };
  return (
    <aside
      aria-label={t("chat.thread.title")}
      className="bg-surface border-divider flex h-full w-[400px] shrink-0 flex-col border-l 2xl:w-[460px]"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented) onClose();
      }}
    >
      <header className="border-hairline flex min-h-12 shrink-0 items-center gap-1 border-b pl-4 pr-2">
        <h2 className="text-ink m-0 min-w-0 flex-1 truncate pr-2 text-[14px]/6 font-semibold">{t("chat.thread.title")}</h2>
        {actions}
        <button
          type="button"
          className={cx(drawerTool, copied && "text-ok")}
          onClick={() => void copyLink()}
          aria-label={copied ? t("peek.copied") : t("peek.copy")}
          title={copied ? t("peek.copied") : t("peek.copy")}
        >
          <CopyIcon />
        </button>
        <button type="button" onClick={onClose} aria-label={t("common.close")} title={t("common.close")} className={drawerTool}>
          <CloseIcon />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" data-ask-thread={rootId}>
        {children}
      </div>
      <div className="border-divider shrink-0 border-t p-3">{footer}</div>
    </aside>
  );
}
