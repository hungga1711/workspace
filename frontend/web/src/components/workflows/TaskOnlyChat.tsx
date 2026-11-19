"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n/client";
import { btnPrimary, cx } from "@/lib/ui";
import { CalendarIcon, CodeIcon, FileIcon, PencilIcon, SendIcon } from "@/components/app/icons";
import { NoAiNotice } from "@/components/ai/NoAiNotice";
// The proposal card (its pickers and date field) loads with the first request, not with AI › Hỏi đáp (route budget).
const TaskProposal = dynamic(() => import("./TaskProposal").then((m) => m.TaskProposal), { ssr: false });

/**
 * AI › Hỏi đáp before the company connects an AI: a private chat that only turns requests into tasks (drafted by
 * rules: title, project, the workflow that fits), so asking the AI for a task works for every company. Questions need
 * a connected model; admins get the link to connect one. Before the first request the
 * composer sits right under a page-sized title with four example requests, like Hỏi đáp with AI; once a request is
 * sent the thread scrolls above a composer at the bottom.
 */
export function TaskOnlyChat({ admin, off = false }: { admin: boolean; off?: boolean }) {
  const t = useT();
  const [turns, setTurns] = useState<{ id: number; text: string }[]>([]);
  const [text, setText] = useState("");
  const end = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [turns.length]);
  const send = () => {
    const v = text.trim();
    if (!v) return;
    setTurns((x) => [...x, { id: Date.now(), text: v }]);
    setText("");
  };
  const examples = [
    { key: "bug", icon: <CodeIcon /> },
    { key: "post", icon: <PencilIcon /> },
    { key: "slides", icon: <CalendarIcon /> },
    { key: "report", icon: <FileIcon /> },
  ] as const;
  // Said first and kept in view: without a connected AI this chat only turns requests into tasks.
  const notice = <NoAiNotice mode="taskOnly" admin={admin} off={off} />;
  const composer = (
    <div className="bg-surface ring-hairline focus-within:ring-accent/50 flex min-w-0 items-end gap-2 rounded-2xl p-2 pl-4 ring-1 transition-shadow focus-within:ring-2">
      <textarea
        ref={field}
        className="text-ink placeholder:text-ink-2 max-h-48 min-h-10 min-w-0 flex-1 resize-none bg-transparent py-2 text-[15px]/6 outline-none [field-sizing:content]"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
        }}
        placeholder={t("workflows.taskChat.placeholder")}
        aria-label={t("workflows.taskChat.placeholder")}
      />
      <button
        type="button"
        className={cx(btnPrimary, "size-10 shrink-0 rounded-xl px-0 disabled:opacity-40")}
        onClick={send}
        disabled={!text.trim()}
        aria-label={t("chat.composer.send")}
      >
        <SendIcon className="size-4" />
      </button>
    </div>
  );

  if (!turns.length)
    return (
      <div className="bg-surface flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="mx-auto grid w-full max-w-2xl gap-5 px-4 pb-10 pt-[12vh] max-sm:pt-8">
          {notice}
          <div className="grid gap-1.5">
            <h2 className="text-ink m-0 text-2xl/8 font-semibold tracking-[-0.02em] max-sm:text-xl/7">{t("workflows.taskChat.title")}</h2>
            <p className="text-ink-2 m-0 text-sm">{t("workflows.taskChat.lead")}</p>
          </div>
          <div className="shadow-card rounded-2xl">{composer}</div>
          <ul className="m-0 grid list-none gap-2 p-0 sm:grid-cols-2">
            {examples.map((x) => (
              <li key={x.key} className="grid">
                <button
                  type="button"
                  onClick={() => {
                    setText(t(`workflows.taskChat.examples.${x.key}`));
                    field.current?.focus();
                  }}
                  className="bg-ground ring-hairline hover:bg-hover text-ink-soft hover:text-ink flex min-w-0 items-start gap-2.5 rounded-xl px-3 py-2.5 text-left text-[13px]/5 ring-1 ring-inset transition-colors"
                >
                  <span aria-hidden="true" className="text-ink-2 mt-0.5 shrink-0 [&_svg]:size-3.5">
                    {x.icon}
                  </span>
                  <span className="min-w-0">{t(`workflows.taskChat.examples.${x.key}`)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    );

  return (
    <div className="bg-surface flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-2xl gap-5 px-4 py-6">
          {notice}
          {turns.map((x) => (
            <div key={x.id} className="grid gap-3">
              <p className="bg-hover m-0 max-w-[80%] justify-self-end whitespace-pre-wrap rounded-2xl rounded-br-md px-4 py-2.5 text-sm">{x.text}</p>
              <TaskProposal text={x.text} />
            </div>
          ))}
          <div ref={end} />
        </div>
      </div>
      <div className="border-hairline shrink-0 border-t px-4 py-3">
        <div className="mx-auto w-full max-w-2xl">{composer}</div>
      </div>
    </div>
  );
}
