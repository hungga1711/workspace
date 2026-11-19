"use client";

import { useT, useFormat } from "@/lib/i18n/client";
import type { T } from "@/lib/i18n/core";
import Link from "next/link";
import { formatMentions } from "@/lib/names";
import { Avatar, useDirectory } from "@/lib/people";
import { ArrowRightIcon, ApprovalIcon, CalendarIcon, ChatIcon, CheckCircleIcon, FileIcon, FolderIcon, HashIcon, PaperclipIcon, WhiteboardIcon } from "@/components/app/icons";
import { fold } from "@/lib/fold";
import { cx } from "@/lib/ui";
import { IconTile, type Tone } from "@/components/ui/Bento";

export interface Hit {
  entity_type: string;
  entity_id: string;
  title: string;
  body: string;
  url: string;
  updated_at: string;
}
const KIND = (tx: T): Record<string, [string, (p: { className?: string }) => React.ReactNode]> => ({
  message: [tx("app.searchresults.tin_nhan"), ChatIcon],
  task: [tx("app.searchresults.viec"), CheckCircleIcon],
  document: [tx("app.searchresults.tai_lieu"), FileIcon],
  whiteboard: [tx("app.searchresults.bang_trang"), WhiteboardIcon],
  project: [tx("app.searchresults.du_an"), FolderIcon],
  file: [tx("app.searchresults.tep"), PaperclipIcon],
  channel: [tx("app.searchresults.kenh"), HashIcon],
  person: [tx("app.searchresults.nguoi"), ChatIcon],
  // Found by their code only (YC-007, H-012): the ⌘K and search "exact code" row.
  approval: [tx("app.searchresults.yeu_cau"), ApprovalIcon],
  meeting: [tx("app.searchresults.cuoc_hop"), CalendarIcon],
});

/** Wraps each case/diacritic-insensitive occurrence of the query terms in <mark>. */
function Mark({ text, q }: { text: string; q?: string }) {
  const terms = (q ?? "")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 1);
  if (!terms.length) return <>{text}</>;
  const f = fold(text);
  const marks: [number, number][] = [];
  for (const t of terms.map(fold)) {
    let i = f.indexOf(t);
    while (i !== -1) {
      marks.push([i, i + t.length]);
      i = f.indexOf(t, i + t.length);
    }
  }
  if (!marks.length || f.length !== text.length) return <>{text}</>;
  marks.sort((a, b) => a[0] - b[0]);
  const out: React.ReactNode[] = [];
  let at = 0;
  for (const [a, b] of marks) {
    if (a < at) continue;
    out.push(
      text.slice(at, a),
      <mark key={a} className="bg-accent-wash text-accent-text rounded-sm font-medium">
        {text.slice(a, b)}
      </mark>,
    );
    at = b;
  }
  out.push(text.slice(at));
  return <>{out}</>;
}

/** Each kind's tone (Home's icon tiles), so a mixed list scans by type. */
const KIND_TONE: Record<string, Tone> = {
  message: "violet",
  task: "sky",
  document: "green",
  whiteboard: "tangerine",
  project: "violet",
  file: "rose",
  channel: "tangerine",
  approval: "green",
  meeting: "tangerine",
};

/**
 * Search hits as rows. On their own (one kind's tab) they are one white card and each row leads with its kind's
 * tinted icon tile; `bare` drops the card and the tile for rows inside a kind's own tile (Tất cả), where the tile's
 * header already names the kind.
 */
export function SearchResults({ hits, q, bare = false }: { hits: Hit[]; q?: string; bare?: boolean }) {
  const { ago } = useFormat();
  const tx = useT();
  const dir = useDirectory();
  const names = dir.names;
  return (
    <ul className={bare ? "m-0 mt-3 grid list-none gap-0.5 p-0" : "divide-divider-soft bg-surface shadow-card m-0 list-none divide-y overflow-hidden rounded-xl p-0"}>
      {hits.map((h) => {
        const [label, Icon] = KIND(tx)[h.entity_type] ?? [h.entity_type, FileIcon];
        const main = h.entity_type === "message" ? h.body : h.title;
        const sub = h.entity_type === "message" ? (h.title ? `#${h.title}` : "") : h.body;
        return (
          <li
            key={`${h.entity_type}:${h.entity_id}`}
            className={cx(
              "group/row relative flex min-w-0 items-center gap-3 transition-colors",
              bare ? "hover:bg-hover -mx-2 min-h-12 rounded-lg px-2 py-2" : "hover:bg-hover/60 min-h-14 px-5 py-3 max-sm:px-4",
            )}
          >
            {h.entity_type === "person" ? (
              <Avatar id={h.entity_id} size="sm" />
            ) : bare ? null : (
              <IconTile tone={KIND_TONE[h.entity_type] ?? "sky"}>
                <Icon />
              </IconTile>
            )}
            <span className="min-w-0 flex-1">
              <Link href={h.url} className="text-ink line-clamp-2 text-sm font-medium no-underline after:absolute after:inset-0">
                <Mark text={formatMentions(main, names)} q={q} />
              </Link>
              <span className="text-ink-2 block truncate text-xs">
                {bare ? null : label}
                {sub ? (
                  <>
                    {bare ? null : " · "}
                    <Mark text={formatMentions(sub, names)} q={q} />
                  </>
                ) : null}
              </span>
            </span>
            <span className="text-ink-2 shrink-0 text-xs tabular-nums">{ago(h.updated_at)}</span>
            <ArrowRightIcon
              aria-hidden="true"
              className="text-ink-2 size-3.5 shrink-0 opacity-0 transition-[opacity,transform] group-hover/row:translate-x-0.5 group-hover/row:opacity-100 max-sm:hidden"
            />
          </li>
        );
      })}
    </ul>
  );
}
