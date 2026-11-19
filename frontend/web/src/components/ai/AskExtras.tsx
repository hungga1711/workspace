"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import { useDirectory } from "@/lib/people";
import { useT } from "@/lib/i18n/client";
import { docHref, meetingHref, projectHref, taskHref } from "@/lib/links";
import { cx, menuItem, menuLabel, popover } from "@/lib/ui";
import { BoardIcon, CalendarIcon, ChartIcon, ChatIcon, CheckCircleIcon, CloseIcon, FileIcon, HashIcon, PaperclipIcon, UsersIcon, WorkflowIcon } from "@/components/app/icons";
import type { RefKind } from "./mention-types";

export type { RefKind } from "./mention-types";

/**
 * Hỏi đáp's extras around the composer: images and files attached to a question, and the work pointed at with @ (a
 * task, document, project, meeting, a file in the Drive, or a workflow to run). The server reads the files and the
 * records (as the asker); this only picks them.
 */

export interface AskRef {
  kind: RefKind;
  id: string;
  label: string;
  code?: string | null;
  /** The screen the ask panel (⌘J) was opened on: shown as "on screen", sent as the question's context. */
  page?: boolean;
  /** A chat channel: the thread open in it. */
  thread?: string;
}
/** A file on a question: being sent (`data`, `preview` for images) or stored (`id`, shown through the files route). */
export interface AskFile {
  key: string;
  id?: string;
  name: string;
  contentType: string;
  size: number;
  kind: "image" | "file";
  data?: string;
  preview?: string;
}

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|ndjson|xml|ya?ml|html?|log|ini|toml|js|jsx|ts|tsx|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|sql|sh|css|scss|vue|svelte)$/i;
/** Word, Excel and PowerPoint: the server reads their text (a workbook as CSV per sheet). */
const OFFICE_EXT = /\.(docx|xlsx|pptx)$/i;
/** What the file picker offers: what the server can read (images, PDF, Office, text and code). */
export const ACCEPT = `${IMAGE_TYPES.join(",")},application/pdf,.pdf,.docx,.xlsx,.pptx,text/*,.md,.csv,.json,.xml,.yaml,.yml,.log,.sql,.js,.ts,.tsx,.py,.go,.java`;
const MAX_TOTAL = 8 * 1024 * 1024;
const MAX_FILES = 6;
/** Models read images up to about this edge; larger ones only cost upload time and tokens. */
const MAX_EDGE = 1600;

export const readable = (f: File) =>
  IMAGE_TYPES.includes(f.type) || f.type === "application/pdf" || f.type.startsWith("text/") || TEXT_EXT.test(f.name) || OFFICE_EXT.test(f.name) || /\.pdf$/i.test(f.name);

const base64Of = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

/** An image at most MAX_EDGE wide or tall, as JPEG (PNG kept when it is already small, for screenshots' sharp text). */
async function shrink(file: File): Promise<Blob> {
  if (file.type === "image/gif") return file;
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
  if (scale === 1 && file.size < 1_500_000) return file;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const type = file.type === "image/png" && scale < 1 && file.size < 1_500_000 ? "image/png" : "image/jpeg";
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b ?? file), type, 0.86));
}

/** Files ready to send; the ones the server cannot read, or past the size limit, come back as `refused`. */
export async function prepareFiles(list: File[], already: AskFile[]): Promise<{ files: AskFile[]; refused: "type" | "size" | "count" | null }> {
  const files: AskFile[] = [];
  let refused: "type" | "size" | "count" | null = null;
  let total = already.reduce((n, f) => n + f.size, 0);
  for (const file of list) {
    if (already.length + files.length >= MAX_FILES) {
      refused = "count";
      break;
    }
    if (!readable(file)) {
      refused = "type";
      continue;
    }
    const image = IMAGE_TYPES.includes(file.type);
    const blob = image ? await shrink(file).catch(() => file) : file;
    if (total + blob.size > MAX_TOTAL) {
      refused = "size";
      continue;
    }
    total += blob.size;
    const data = await base64Of(blob);
    const contentType = image
      ? blob.type || file.type
      : file.type || (/\.pdf$/i.test(file.name) ? "application/pdf" : OFFICE_EXT.test(file.name) ? "application/octet-stream" : "text/plain");
    files.push({
      key: `${file.name}-${Math.random().toString(36).slice(2, 8)}`,
      name: file.name,
      contentType,
      size: blob.size,
      kind: image ? "image" : "file",
      data,
      ...(image ? { preview: `data:${contentType};base64,${data}` } : {}),
    });
  }
  return { files, refused };
}

const kb = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const src = (f: AskFile) => f.preview ?? (f.id ? `/api/proxy/ai/assistant/files/${f.id}` : "");

export const refHref = (r: AskRef) =>
  r.kind === "channel"
    ? `/app/chat/${r.id}`
    : r.kind === "message"
      ? `/app/chat/m/${r.id}`
      : r.kind === "person"
        ? `/app/work/people/${r.id}`
        : r.kind === "report"
          ? `/app/ai/${r.id}`
          : refHrefWork(r);
const refHrefWork = (r: AskRef) =>
  r.kind === "task"
    ? taskHref(r)
    : r.kind === "document"
      ? docHref(r)
      : r.kind === "project"
        ? projectHref(r)
        : r.kind === "workflow"
          ? `/app/ai/workflows/${r.id}`
          : r.kind === "file"
            ? // Only the Drive item's id and name are known here: the Drive's own search finds it.
              `/app/work/docs?view=files&q=${encodeURIComponent(r.label)}`
            : meetingHref(r);
function RefIcon({ kind, className }: { kind: RefKind; className?: string }) {
  const Icon = kind === "channel" ? HashIcon : kind === "message" ? ChatIcon : kind === "person" ? UsersIcon : kind === "report" ? ChartIcon : workIcon(kind);
  return <Icon className={className} aria-hidden="true" />;
}
const workIcon = (kind: RefKind) =>
  kind === "task"
    ? CheckCircleIcon
    : kind === "document"
      ? FileIcon
      : kind === "project"
        ? BoardIcon
        : kind === "workflow"
          ? WorkflowIcon
          : kind === "file"
            ? PaperclipIcon
            : CalendarIcon;

/** In the composer: what goes with the next question, each with a remove button. */
export function PendingChips({
  files,
  refs,
  onRemoveFile,
  onRemoveRef,
}: {
  files: AskFile[];
  refs: AskRef[];
  onRemoveFile: (key: string) => void;
  onRemoveRef: (r: AskRef) => void;
}) {
  const t = useT();
  if (!files.length && !refs.length) return null;
  const x = "text-ink-2 hover:bg-hover hover:text-ink grid size-6 shrink-0 place-items-center rounded-md [&_svg]:size-3.5";
  return (
    <ul className="m-0 flex list-none flex-wrap gap-1.5 px-2 pb-1 pt-1.5" aria-label={t("aiw.chat.extras.attached")}>
      {files.map((f) => (
        <li key={f.key} className="border-hairline bg-ground flex h-10 max-w-56 items-center gap-2 rounded-lg border pl-1 pr-0.5">
          {f.kind === "image" ? (
            <img src={src(f)} alt="" className="size-8 shrink-0 rounded-md object-cover" />
          ) : (
            <span className="bg-surface text-ink-2 grid size-8 shrink-0 place-items-center rounded-md">
              <FileIcon className="size-4" />
            </span>
          )}
          <span className="min-w-0 text-xs leading-tight">
            <span className="text-ink block truncate font-medium">{f.name}</span>
            <span className="text-ink-2">{kb(f.size)}</span>
          </span>
          <button type="button" className={x} aria-label={t("aiw.chat.extras.remove", { name: f.name })} onClick={() => onRemoveFile(f.key)}>
            <CloseIcon />
          </button>
        </li>
      ))}
      {refs.map((r) => (
        <li
          key={`${r.kind}:${r.id}`}
          className={cx(
            "flex h-8 max-w-64 items-center gap-1.5 self-center rounded-lg pl-2 pr-0.5 text-xs",
            r.page ? "border-hairline text-ink border border-dashed" : "bg-selected text-ink",
          )}
          title={r.page ? t("aiw.panel.onScreenHint") : undefined}
        >
          <RefIcon kind={r.kind} className="text-ink-2 size-3.5 shrink-0" />
          {r.page ? <span className="text-ink-2 shrink-0">{t("aiw.panel.onScreen")}</span> : null}
          <span className="truncate font-medium">{r.label}</span>
          <button type="button" className={x} aria-label={t("aiw.chat.extras.remove", { name: r.label })} onClick={() => onRemoveRef(r)}>
            <CloseIcon />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Under a sent question: its images (open full size), files and the work it pointed at (links). */
export function SentExtras({ files = [], refs = [] }: { files?: AskFile[]; refs?: AskRef[] }) {
  const t = useT();
  if (!files.length && !refs.length) return null;
  const images = files.filter((f) => f.kind === "image");
  const docs = files.filter((f) => f.kind === "file");
  return (
    <div className="flex max-w-[85%] flex-col items-end gap-1.5">
      {images.length ? (
        <ul className="m-0 flex list-none flex-wrap justify-end gap-1.5 p-0" aria-label={t("aiw.chat.extras.images")}>
          {images.map((f) => (
            <li key={f.key}>
              <a href={src(f)} target="_blank" rel="noreferrer" className="block">
                <img src={src(f)} alt={f.name} loading="lazy" className="border-hairline max-h-48 max-w-60 rounded-xl border object-cover" />
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      {docs.length || refs.length ? (
        <ul className="m-0 flex list-none flex-wrap justify-end gap-1.5 p-0">
          {docs.map((f) => (
            <li key={f.key} className="border-hairline bg-surface text-ink flex h-8 max-w-60 items-center gap-1.5 rounded-lg border px-2 text-xs">
              <FileIcon className="text-ink-2 size-3.5 shrink-0" />
              <span className="truncate font-medium">{f.name}</span>
              <span className="text-ink-2 shrink-0">{kb(f.size)}</span>
            </li>
          ))}
          {refs.map((r) => (
            <li key={`${r.kind}:${r.id}`}>
              <Link href={refHref(r)} className="bg-selected text-ink hover:bg-hover flex h-8 max-w-64 items-center gap-1.5 rounded-lg px-2 text-xs no-underline">
                <RefIcon kind={r.kind} className="text-ink-2 size-3.5 shrink-0" />
                <span className="truncate font-medium">{r.label}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

interface Option extends AskRef {
  hint?: string;
}

/** The @ being typed right before the caret ("@pay" → "pay"), or null when the caret is not in one. */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const m = /(^|\s)@([^\s@]{0,40})$/u.exec(text.slice(0, caret));
  return m ? { start: caret - m[2]!.length - 1, query: m[2]! } : null;
}

/**
 * The @ picker over the composer: tasks, documents, projects and meetings this person can open. Without a query it
 * offers their open tasks, the projects and the next meetings; with one it searches (the server checks access again).
 */
export function MentionMenu({
  query,
  myTasks,
  onPick,
  keys,
}: {
  query: string;
  myTasks: { id: string; code?: string | null; title: string }[];
  onPick: (r: AskRef) => void;
  /** The composer hands its arrow, Enter, Tab and Escape keys here while the menu is open; true when used. */
  keys: React.MutableRefObject<((e: React.KeyboardEvent) => boolean) | null>;
}) {
  const t = useT();
  const dir = useDirectory();
  const [options, setOptions] = useState<Option[]>([]);
  const [sel, setSel] = useState(0);
  // Projects, meetings and channels are short lists: read once per menu and filtered here.
  const lists = useRef<Promise<{ projects: Option[]; meetings: Option[]; workflows: Option[]; channels: Option[] }> | null>(null);
  lists.current ??= Promise.all([
    // Workflows this workspace has: pointing at one asks the AI to run it (on a task named in the question).
    api<{ workflows: { id: string; name: string }[] }>("work/workflows")
      .then((r) => r.workflows.map((w): Option => ({ kind: "workflow", id: w.id, label: w.name })))
      .catch(() => [] as Option[]),
    api<{ projects: { id: string; code: string; name: string }[] }>("work/projects")
      .then((r) => r.projects.map((p): Option => ({ kind: "project", id: p.id, code: p.code, label: `${p.code} ${p.name}` })))
      .catch(() => [] as Option[]),
    Promise.all(
      ["work/meetings", "work/meetings?when=past"].map((u) =>
        api<{ meetings: { id: string; code: string | null; title: string; startsAt: string }[] }>(u).catch(() => ({ meetings: [] })),
      ),
    )
      .then((both) =>
        both
          .flatMap((r) => r.meetings)
          .map((m): Option => ({ kind: "meeting", id: m.id, code: m.code, label: m.code ? `${m.code} ${m.title}` : m.title, hint: m.startsAt.slice(0, 10) })),
      )
      .catch(() => [] as Option[]),
    // Channels the person is in (direct messages are named by people, and asked about as a person).
    api<{ channels: { id: string; name: string | null; displayName?: string | null; kind: string }[] }>("chat/channels")
      .then((r) => r.channels.filter((c) => c.kind !== "dm" && (c.displayName || c.name)).map((c): Option => ({ kind: "channel", id: c.id, label: `#${c.displayName || c.name}` })))
      .catch(() => [] as Option[]),
  ]).then(([workflows, projects, meetings, channels]) => ({ projects, meetings, workflows, channels }));

  useEffect(() => {
    let live = true;
    const q = query.trim().toLowerCase();
    const has = (o: Option) => o.label.toLowerCase().includes(q);
    const timer = setTimeout(
      () => {
        const searched: Promise<Option[]> =
          q.length < 2
            ? Promise.resolve(
                myTasks
                  .filter((x) => !q || `${x.code ?? ""} ${x.title}`.toLowerCase().includes(q))
                  .map((x): Option => ({ kind: "task", id: x.id, code: x.code ?? null, label: x.code ? `${x.code} ${x.title}` : x.title })),
              )
            : api<{ hits: { entity_type: string; entity_id: string; title: string }[] }>(`chat/search?types=task,document&q=${encodeURIComponent(q)}`)
                .then((r) =>
                  r.hits.map((h): Option => {
                    // The index stores tasks as "T-041 Title": the code is the first word.
                    const code = h.entity_type === "task" ? (h.title.split(" ")[0] ?? null) : null;
                    return { kind: h.entity_type === "task" ? "task" : "document", id: h.entity_id, code, label: h.title };
                  }),
                )
                .catch(() => []);
        // Files in the Drive: the latest ones before anything is typed, by name after.
        const drive: Promise<Option[]> = api<{ items: { id: string; kind: string; name: string }[] }>(
          q.length < 2 ? "work/drive?section=recent" : `work/drive?q=${encodeURIComponent(q)}`,
        )
          .then((r) => r.items.filter((x) => x.kind === "file").map((x): Option => ({ kind: "file", id: x.id, label: x.name })))
          .catch(() => []);
        void Promise.all([searched, lists.current!, drive]).then(([found, l, files]) => {
          if (!live) return;
          // Search is fuzzy: within a kind, what contains the typed text exactly comes first.
          const best = (list: Option[], n: number) => [...list.filter(has), ...list.filter((o) => !has(o))].slice(0, n);
          const exact = (list: Option[], n: number) => list.filter(has).slice(0, n);
          // One section per kind, in the order people reach for them; the list below is drawn with a heading per section.
          // People from the directory the app already holds; only once something is typed (a list of everyone is noise).
          const people = q
            ? dir.people
                .filter((p) => p.displayName.toLowerCase().includes(q) || (p.nickname ?? "").toLowerCase().includes(q))
                .slice(0, 3)
                .map((p): Option => ({ kind: "person", id: p.userId, label: p.displayName }))
            : [];
          setOptions([
            ...best(
              found.filter((o) => o.kind === "task"),
              q ? 5 : 4,
            ),
            ...best(
              found.filter((o) => o.kind === "document"),
              4,
            ),
            ...exact(files, q ? 4 : 3),
            ...exact(l.projects, 3),
            ...exact(l.meetings, 3),
            ...exact(l.workflows, q ? 4 : 3),
            ...people,
            ...(q ? exact(l.channels, 3) : []),
          ]);
          setSel(0);
        });
      },
      q.length < 2 ? 0 : 160,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, myTasks, dir.people]);

  // Above the composer where there is room; on the welcome screen the composer sits near the top, so it opens below.
  const box = useRef<HTMLDivElement>(null);
  const [below, setBelow] = useState(false);
  useLayoutEffect(() => {
    const host = box.current?.parentElement;
    if (host) setBelow(host.getBoundingClientRect().top < 420);
  }, []);
  // The highlighted option stays in view when the arrows walk past the edge of the list.
  useEffect(() => {
    box.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [sel, options]);

  keys.current = (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!options.length) return false;
      setSel((s) => (s + (e.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
      return true;
    }
    if ((e.key === "Enter" || e.key === "Tab") && options[sel]) {
      onPick(options[sel]!);
      return true;
    }
    return false;
  };

  return (
    <div ref={box} className={cx(popover, "absolute left-0 z-30 w-[min(28rem,100%)]", below ? "top-full mt-1.5" : "bottom-full mb-1.5")}>
      {options.length ? (
        <ul role="listbox" aria-label={t("aiw.chat.extras.mentionLabel")} className="m-0 max-h-72 list-none overflow-y-auto p-0">
          {options.map((o, i) => (
            <li key={`${o.kind}:${o.id}`} role="option" aria-selected={i === sel}>
              {options[i - 1]?.kind !== o.kind ? <p className={cx(menuLabel, i ? "border-divider-soft mt-1 border-t pt-2" : "")}>{t(`aiMention.kinds.${o.kind}`)}</p> : null}
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  onPick(o);
                }}
                onMouseEnter={() => setSel(i)}
                className={cx(menuItem, "px-2", i === sel && "bg-brand-wash hover:bg-brand-wash")}
              >
                <RefIcon kind={o.kind} className="text-ink-2 size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {o.hint ? <span className="text-ink-2 shrink-0 text-xs">{o.hint}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-ink-2 m-0 px-2 py-1.5 text-xs">{query.trim().length < 2 ? t("aiw.chat.extras.mentionHint") : t("aiw.chat.extras.mentionNone")}</p>
      )}
    </div>
  );
}
