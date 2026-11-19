"use client";

import { useT } from "@/lib/i18n/client";
import { Fragment } from "react";
import { cx } from "@/lib/ui";
import { useTaskCodeRe } from "@/lib/task-refs";
import { TaskRef } from "./TaskRef";
import { PersonTrigger } from "./PersonTrigger";

/**
 * Chat formatting (a safe Markdown subset, rendered as React elements, never as HTML):
 * ```code blocks```, > quotes, - / 1. lists, `code`, **bold**, *italic* / _italic_, ~~strike~~,
 * bare links, <@id> mentions and task codes ("T-041", in the workspace's format: a chip that opens the task; not in
 * `compact` previews). Mentions of the viewer use the amber signal.
 */
/** Words RichText itself prints, localized once per render. */
interface Labels {
  source: string;
  unknownUser: string;
  /** Task codes to turn into chips (full messages only). */
  codes: RegExp | null;
  /** Mentions open the person's card (full messages only; a compact preview is itself a link or button). */
  cards: boolean;
}

export function RichText({ text, names, me, compact = false }: { text: string; names: Record<string, string>; me?: string; compact?: boolean }) {
  const t = useT();
  const codes = useTaskCodeRe();
  const lb: Labels = { source: t("chat.rich.source"), unknownUser: t("chat.rich.unknownUser"), codes: compact ? null : codes, cards: !compact };
  const blocks: React.ReactNode[] = [];
  const parts = text.split(/```/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const code = part.replace(/^[a-z0-9+-]*\n/i, "").replace(/\n$/, "");
      blocks.push(
        compact ? (
          <code key={i} className="bg-hover rounded-sm px-1 font-mono text-xs">
            {code}
          </code>
        ) : (
          <pre key={i} className="border-hairline bg-ground my-1 overflow-x-auto whitespace-pre rounded-md border p-2.5 font-mono text-xs/[1.5]">
            {code}
          </pre>
        ),
      );
      return;
    }
    if (!part) return;
    blocks.push(<Fragment key={i}>{lines(part, names, me, compact, i, lb)}</Fragment>);
  });
  return <>{blocks}</>;
}

function lines(text: string, names: Record<string, string>, me: string | undefined, compact: boolean, k: number, lb: Labels): React.ReactNode[] {
  if (compact)
    return [
      <Fragment key={k}>
        {inline(
          text
            .split("\n")
            .map((l) => l.replace(/^\s*(>\s?|[-*•]\s+|\d+[.)]\s+)/, ""))
            .filter(Boolean)
            .join(" · "),
          names,
          me,
          lb,
        )}
      </Fragment>,
    ];
  const out: React.ReactNode[] = [];
  const rows = text.split("\n");
  let i = 0;
  while (i < rows.length) {
    const r = rows[i]!;
    if (/^>\s?/.test(r)) {
      const q: string[] = [];
      while (i < rows.length && /^>\s?/.test(rows[i]!)) q.push(rows[i++]!.replace(/^>\s?/, ""));
      out.push(
        <blockquote key={`q${k}-${i}`} className="border-hairline text-ink-2 my-0.5 border-l-2 pl-3">
          {q.map((x, j) => (
            <Fragment key={j}>
              {j ? <br /> : null}
              {inline(x, names, me, lb)}
            </Fragment>
          ))}
        </blockquote>,
      );
      continue;
    }
    if (/^\s*([-*•]|\d+[.)])\s+/.test(r)) {
      const ordered = /^\s*\d+[.)]\s+/.test(r);
      const items: string[] = [];
      while (i < rows.length && (ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*•]\s+/).test(rows[i]!)) items.push(rows[i++]!.replace(/^\s*([-*•]|\d+[.)])\s+/, ""));
      const L = ordered ? "ol" : "ul";
      out.push(
        <L key={`l${k}-${i}`} className={cx("my-0.5 pl-5", ordered ? "list-decimal" : "list-disc")}>
          {items.map((x, j) => (
            <li key={j}>{inline(x, names, me, lb)}</li>
          ))}
        </L>,
      );
      continue;
    }
    out.push(
      <Fragment key={`t${k}-${i}`}>
        {out.length && !/^(blockquote|ul|ol)$/.test(String((out.at(-1) as { type?: unknown })?.type)) ? "\n" : ""}
        {inline(r, names, me, lb)}
      </Fragment>,
    );
    i++;
  }
  return out;
}

// `[message <ULID>]` is how AI answers cite a chat message; it renders as a "nguồn" link (DESIGN.md: AI claims link to their source).
const TOKEN =
  /(\[message [0-9A-HJKMNP-TV-Z]{26}\]|`[^`\n]+`|\*\*[^*\n]+\*\*|~~[^~\n]+~~|(?<![\w*])\*[^*\n]+\*(?![\w*])|(?<![\w])_[^_\n]+_(?![\w])|<@(?:agent:)?[\w-]{1,64}>|https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

function inline(text: string, names: Record<string, string>, me: string | undefined, lb: Labels): React.ReactNode[] {
  return text.split(TOKEN).map((p, i) => {
    if (!p) return null;
    if (i % 2 === 0) return <Fragment key={i}>{withTaskCodes(p, lb.codes)}</Fragment>;
    const src = p.match(/^\[message ([0-9A-Z]{26})\]$/);
    if (src)
      return (
        <a key={i} href={`/app/chat/m/${src[1]}`} className="text-brand-text text-[0.92em] underline decoration-dotted underline-offset-2">
          {lb.source}
        </a>
      );
    if (p.startsWith("`"))
      return (
        <code key={i} className="bg-hover rounded-sm px-1 py-px font-mono text-xs">
          {p.slice(1, -1)}
        </code>
      );
    if (p.startsWith("**"))
      return (
        <strong key={i} className="font-semibold">
          {inline(p.slice(2, -2), names, me, lb)}
        </strong>
      );
    if (p.startsWith("~~")) return <s key={i}>{p.slice(2, -2)}</s>;
    if (p.startsWith("*") || p.startsWith("_")) return <em key={i}>{p.slice(1, -1)}</em>;
    const m = p.match(/^<@(agent:)?([\w-]{1,64})>$/);
    if (m) {
      const label = m[1] ? "@Agent" : `@${names[m[2]!] ?? lb.unknownUser}`;
      const look = cx("rounded-sm px-0.5 font-medium", m[2] === me ? "bg-signal-wash text-signal-text" : "bg-brand-wash text-ink");
      // A known person opens their profile card on hover or click, like their avatar and name on a message.
      return !m[1] && lb.cards && names[m[2]!] ? (
        <PersonTrigger key={i} userId={m[2]!} className={cx(look, "inline hover:underline")}>
          {label}
        </PersonTrigger>
      ) : (
        <span key={i} className={look}>
          {label}
        </span>
      );
    }
    return (
      <a key={i} href={p} target="_blank" rel="noopener noreferrer nofollow" className="text-brand-text break-all underline">
        {p}
      </a>
    );
  });
}

/** Plain text with its task codes as chips. */
function withTaskCodes(text: string, codes: RegExp | null): React.ReactNode {
  if (!codes) return text;
  const out: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(codes)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(<TaskRef key={m.index} code={m[0]} />);
    last = m.index + m[0].length;
  }
  if (!out.length) return text;
  out.push(text.slice(last));
  return out;
}
