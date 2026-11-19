"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import { useFeature } from "@/lib/features-context";
import { useFormat, useT } from "@/lib/i18n/client";
import { docHref, taskHref } from "@/lib/links";
import { uploadWorkFile } from "@/lib/work-files";
import { btn, cx } from "@/lib/ui";
import { CheckIcon, CloseIcon, FileIcon, FolderIcon, GlobeIcon, InfoIcon, LinkIcon, PaperclipIcon, PlusIcon, RefreshIcon, WorkIcon } from "@/components/app/icons";
import { kb } from "@/components/chat/attachments";
import { Checkbox } from "@/components/ui/Checkbox";
import { LIMITS, type LinkCheck, type Prompting, type Resources } from "../types";
import { Group, RichField, SectionCard } from "./parts";
import { DrivePicker, LinkForm, PagePicker, Panel, TaskPicker } from "./resources/pickers";
import type { SectionProps } from "./sections";

/**
 * 4 · What the AI reads before it works (for companies whose material already lives somewhere):
 * the task being worked on, then one list of sources of every kind (pages of Docs, files of the workspace's Drive,
 * other tasks, uploaded files, links to Google Drive or the web), and the company's standing instructions. Every AI
 * step reads all of it, as the person who starts the run. A link is checked as it is added, so "the AI cannot open
 * this" is said here and not found out in a run.
 */

/** Files whose text the AI reads (the server's extract.ts); anything else stays a file. */
const READABLE = /\.(txt|md|markdown|csv|tsv|json|ya?ml|xml|html?|log|ini|toml|pdf|docx|xlsx|pptx)$/i;
const DOCUMENT = /\.(pdf|docx|xlsx|pptx)$/i;
const aiReads = (name: string, size?: number) => READABLE.test(name) && (size === undefined || size <= (DOCUMENT.test(name) ? 15 : 1) * 1024 * 1024);

type Adding = "page" | "drive" | "task" | "link" | null;
type Checked = LinkCheck | "checking" | "failed";

export function ResourcesSection({ d, set }: SectionProps & { prompting: Prompting | null }) {
  const t = useT();
  const f = useFormat();
  const docsOn = useFeature("docs");
  const r = d.config.resources;
  const change = useCallback(
    (fn: (r: Resources) => Partial<Resources>) => set((x) => ({ ...x, config: { ...x.config, resources: { ...x.config.resources, ...fn(x.config.resources) } } })),
    [set],
  );
  const runner = d.config.environment.kind !== "assistant";
  const [adding, setAdding] = useState<Adding>(null);

  // ── Uploads: the file dialog, or files dropped anywhere on the section ──
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(0);
  const [fileError, setFileError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const upload = async (list: FileList | File[]) => {
    setFileError(null);
    const files = [...list].slice(0, Math.max(0, LIMITS.files - r.files.length));
    if (!files.length) return;
    setUploading((n) => n + files.length);
    for (const file of files) {
      try {
        const a = await uploadWorkFile(file, { type: "workflow", id: d.id ?? "draft" });
        change((x) => ({ files: [...x.files, { id: a.fileId, name: a.name, size: a.size, contentType: a.contentType }].slice(0, LIMITS.files) }));
      } catch (e) {
        setFileError((e as { body?: { message?: string } }).body?.message ?? t("workflows.studio.res.uploadFailed", { name: file.name }));
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  // ── Links: each is checked when added, and once for the links already there when the section comes into view ──
  const [checks, setChecks] = useState<Record<string, Checked>>({});
  const check = useCallback(
    async (url: string, named: boolean) => {
      setChecks((c) => ({ ...c, [url]: "checking" }));
      try {
        const res = await api<LinkCheck>("work/workflows/links/check", { method: "POST", body: { url } });
        setChecks((c) => ({ ...c, [url]: res }));
        // A link nobody named takes its first words as its name, so the list reads as documents, not addresses.
        if (res.ok && !named && res.sample.trim()) change((x) => ({ links: x.links.map((l) => (l.url === url && !l.title ? { ...l, title: firstWords(res.sample) } : l)) }));
      } catch {
        setChecks((c) => ({ ...c, [url]: "failed" }));
      }
    },
    [change],
  );
  const root = useRef<HTMLDivElement>(null);
  const seen = useRef(false);
  const links = useRef(r.links);
  links.current = r.links;
  useEffect(() => {
    const el = root.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      if (seen.current || !entries.some((e) => e.isIntersecting)) return;
      seen.current = true;
      io.disconnect();
      // Quietly, two at a time: the server fetches each address.
      const queue = links.current.map((l) => l.url);
      const next = (): Promise<void> => {
        const url = queue.shift();
        return url ? check(url, true).then(next) : Promise.resolve();
      };
      void Promise.all([next(), next()]);
    });
    io.observe(el);
    return () => io.disconnect();
  }, [check]);
  const addLinks = (list: { url: string; title: string }[]) => {
    const fresh = list.filter((l) => !r.links.some((x) => x.url === l.url)).slice(0, Math.max(0, LIMITS.links - r.links.length));
    if (!fresh.length) return;
    change((x) => ({ links: [...x.links, ...fresh].slice(0, LIMITS.links) }));
    for (const l of fresh) void check(l.url, !!l.title);
  };

  // ── The one list ──
  const rows: RowProps[] = [
    ...(docsOn
      ? r.docs.map((p) => ({
          key: `p${p.id}`,
          icon: <FileIcon />,
          name: p.title || t("workflows.studio.res.untitled"),
          href: docHref({ id: p.id }),
          kind: t("workflows.studio.res.kind.page"),
          reads: true,
          onRemove: () => change((x) => ({ docs: x.docs.filter((y) => y.id !== p.id) })),
        }))
      : []),
    ...r.drive.map((x) => ({
      key: `d${x.id}`,
      icon: <FolderIcon />,
      name: x.name,
      href: `/app/work/docs?view=files&q=${encodeURIComponent(x.name)}`,
      kind: t("workflows.studio.res.kind.drive"),
      reads: aiReads(x.name),
      onRemove: () => change((y) => ({ drive: y.drive.filter((z) => z.id !== x.id) })),
    })),
    ...r.tasks.map((x) => ({
      key: `t${x.id}`,
      icon: <WorkIcon />,
      name: x.title || x.code,
      href: taskHref({ id: x.id, code: x.code }),
      kind: x.code ? `${t("workflows.studio.res.kind.task")} ${x.code}` : t("workflows.studio.res.kind.task"),
      reads: true,
      onRemove: () => change((y) => ({ tasks: y.tasks.filter((z) => z.id !== x.id) })),
    })),
    ...r.files.map((x) => ({
      key: `f${x.id}`,
      icon: <PaperclipIcon />,
      name: x.name,
      href: `/app/files/${x.id}`,
      kind: `${t("workflows.studio.res.kind.upload")} · ${kb(x.size)}`,
      reads: aiReads(x.name, x.size),
      onRemove: () => change((y) => ({ files: y.files.filter((z) => z.id !== x.id) })),
    })),
    ...r.links.map((l) => {
      const c = checks[l.url];
      const known = c && c !== "checking" && c !== "failed" ? c : null;
      return {
        key: `l${l.url}`,
        icon: known && known.kind !== "web" ? <FolderIcon /> : c ? <GlobeIcon /> : <LinkIcon />,
        name: l.title || l.url.replace(/^https?:\/\//, ""),
        href: l.url,
        kind: known ? t(`workflows.studio.res.kind.${known.kind}`) : t("workflows.studio.res.kind.web"),
        sub: known?.ok ? known.sample : l.title ? l.url.replace(/^https?:\/\//, "") : undefined,
        state:
          c === "checking" ? (
            <span className="text-ink-2">{t("workflows.studio.res.link.checking")}</span>
          ) : known?.ok ? (
            <span className="text-ok inline-flex items-center gap-1">
              <CheckIcon aria-hidden="true" className="size-3.5" />
              {t("workflows.studio.res.link.chars", { n: f.number(known.chars, 0) })}
            </span>
          ) : null,
        problem: c === "failed" ? t("workflows.studio.res.problem.failed") : known && !known.ok ? t(`workflows.studio.res.problem.${known.problem}`) : undefined,
        onRecheck: c && c !== "checking" ? () => void check(l.url, true) : undefined,
        onRemove: () => change((y) => ({ links: y.links.filter((z) => z.url !== l.url) })),
      };
    }),
  ];

  const adders: { key: Exclude<Adding, null> | "upload"; label: string; icon: React.ReactNode; count: number; max: number }[] = [
    ...(docsOn ? [{ key: "page" as const, label: t("workflows.studio.res.add.page"), icon: <FileIcon />, count: r.docs.length, max: LIMITS.docs }] : []),
    { key: "drive", label: t("workflows.studio.res.add.drive"), icon: <FolderIcon />, count: r.drive.length, max: LIMITS.drive },
    { key: "task", label: t("workflows.studio.res.add.task"), icon: <WorkIcon />, count: r.tasks.length, max: LIMITS.tasks },
    { key: "upload", label: t("workflows.studio.res.add.upload"), icon: <PaperclipIcon />, count: r.files.length, max: LIMITS.files },
    { key: "link", label: t("workflows.studio.res.add.link"), icon: <LinkIcon />, count: r.links.length, max: LIMITS.links },
  ];

  return (
    <div
      ref={root}
      className={cx("min-w-0 rounded-xl", over && "outline-ink outline-dashed outline-2 outline-offset-2")}
      onDragOver={(e) => {
        if (![...e.dataTransfer.types].includes("Files")) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setOver(false);
        void upload(e.dataTransfer.files);
      }}
    >
      <SectionCard n={4} title={t("workflows.studio.section.resources")} hint={over ? t("workflows.studio.res.dropHere") : t("workflows.studio.res.lead")}>
        {/* The task itself: always read, never removed; how much of it is the only choice. */}
        <div className="bg-ground ring-hairline grid min-w-0 gap-2.5 rounded-xl p-3 ring-1 ring-inset">
          <div className="flex min-w-0 items-center gap-2.5">
            <span aria-hidden="true" className="bg-surface ring-hairline text-ink-soft grid size-8 shrink-0 place-items-center rounded-[9px] ring-1 ring-inset [&_svg]:size-4">
              <WorkIcon />
            </span>
            <span className="min-w-0 flex-1">
              <span className="text-ink block text-sm font-medium">{t("workflows.studio.res.task.title")}</span>
              <span className="text-ink-2 block text-xs">{t("workflows.studio.res.task.always")}</span>
            </span>
          </div>
          <div className="grid min-w-0 gap-2 sm:grid-cols-2 sm:pl-[2.625rem]">
            <Checkbox label={t("workflows.studio.res.task.context")} checked={r.taskContext} onChange={(e) => change(() => ({ taskContext: e.target.checked }))} />
            <Checkbox
              label={t("workflows.studio.res.task.files")}
              hint={runner ? undefined : t("workflows.studio.res.task.filesOff")}
              checked={runner && r.taskFiles}
              disabled={!runner}
              onChange={(e) => change(() => ({ taskFiles: e.target.checked }))}
            />
          </div>
        </div>

        <Group label={t("workflows.studio.res.sources")}>
          {rows.length ? (
            <ul className="divide-divider-soft ring-hairline m-0 grid min-w-0 list-none divide-y rounded-xl p-0 ring-1 ring-inset">
              {rows.map(({ key, ...row }) => (
                <Row key={key} {...row} />
              ))}
            </ul>
          ) : (
            <p className="text-ink-2 border-edge m-0 rounded-xl border border-dashed px-3 py-4 text-center text-[13px]">{t("workflows.studio.res.empty")}</p>
          )}
          {uploading > 0 ? <p className="text-ink-2 m-0 text-xs">{t("workflows.studio.res.uploading", { count: uploading })}</p> : null}
          {fileError ? (
            <p role="alert" className="text-block m-0 text-xs">
              {fileError}
            </p>
          ) : null}
          {rows.length > 6 ? <p className="text-ink-2 m-0 text-xs">{t("workflows.studio.res.many")}</p> : null}
        </Group>

        <div className="grid min-w-0 gap-2">
          <span className="text-ink-2 text-xs font-medium">{t("workflows.studio.res.add.title")}</span>
          <input
            ref={fileInput}
            type="file"
            multiple
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(e) => {
              if (e.target.files) void upload(e.target.files);
              e.target.value = "";
            }}
          />
          <div className="grid min-w-0 grid-cols-2 gap-2 sm:flex sm:flex-wrap">
            {adders.map((a) => {
              const full = a.count >= a.max;
              const on = a.key !== "upload" && adding === a.key;
              return (
                <button
                  key={a.key}
                  type="button"
                  disabled={full || (a.key === "upload" && uploading > 0)}
                  title={full ? t("workflows.studio.res.add.full", { max: a.max }) : undefined}
                  aria-expanded={a.key === "upload" ? undefined : on}
                  onClick={() => (a.key === "upload" ? fileInput.current?.click() : setAdding(on ? null : a.key))}
                  className={cx(btn, "min-w-0 justify-start gap-2 max-sm:h-10", on && "bg-selected ring-edge")}
                >
                  <span aria-hidden="true" className="text-ink-2 shrink-0 [&_svg]:size-4">
                    {a.key === "upload" || on ? a.icon : <PlusIcon />}
                  </span>
                  <span className="min-w-0 text-left leading-tight sm:truncate">{a.label}</span>
                </button>
              );
            })}
          </div>
          {adding === "page" ? (
            <Panel title={t("workflows.studio.res.add.page")} onClose={() => setAdding(null)}>
              <PagePicker
                picked={new Set(r.docs.map((x) => x.id))}
                full={r.docs.length >= LIMITS.docs}
                onPick={(p) => change((x) => ({ docs: x.docs.some((y) => y.id === p.id) ? x.docs : [...x.docs, p] }))}
              />
            </Panel>
          ) : adding === "drive" ? (
            <Panel title={t("workflows.studio.res.add.drive")} onClose={() => setAdding(null)}>
              <DrivePicker
                picked={new Set(r.drive.map((x) => x.id))}
                full={r.drive.length >= LIMITS.drive}
                onPick={(p) => change((x) => ({ drive: x.drive.some((y) => y.id === p.id) ? x.drive : [...x.drive, p] }))}
              />
            </Panel>
          ) : adding === "task" ? (
            <Panel title={t("workflows.studio.res.add.task")} onClose={() => setAdding(null)}>
              <TaskPicker
                picked={new Set(r.tasks.map((x) => x.id))}
                full={r.tasks.length >= LIMITS.tasks}
                onPick={(p) => change((x) => ({ tasks: x.tasks.some((y) => y.id === p.id) ? x.tasks : [...x.tasks, p] }))}
              />
            </Panel>
          ) : adding === "link" ? (
            <Panel title={t("workflows.studio.res.add.link")} onClose={() => setAdding(null)}>
              <LinkForm full={r.links.length >= LIMITS.links} onAdd={addLinks} />
            </Panel>
          ) : null}
        </div>

        <div className="border-divider-soft min-w-0 border-t pt-4">
          <Group label={t("workflows.studio.res.notes")} hint={t("workflows.studio.res.notesHint")}>
            <RichField
              label={t("workflows.studio.res.notes")}
              value={r.notes}
              onChange={(v) => change(() => ({ notes: v }))}
              maxLength={LIMITS.notes}
              placeholder={t("workflows.studio.res.notesPh")}
              minRows="min-h-28"
            />
          </Group>
        </div>
      </SectionCard>
    </div>
  );
}

interface RowProps {
  key: string;
  icon: React.ReactNode;
  name: string;
  href: string;
  /** What it is, in a word or two ("Page", "Google Sheet", "Uploaded file · 24 KB"). */
  kind: string;
  /** A second line under the name: a link's first words. */
  sub?: string | undefined;
  /** Files and pages: whether the AI reads its text or only keeps the file. Links say their own state. */
  reads?: boolean | undefined;
  state?: React.ReactNode;
  /** Why the AI cannot read it; the source stays listed. */
  problem?: string | undefined;
  onRecheck?: (() => void) | undefined;
  onRemove: () => void;
}

/** One source: what it is, its name (opens in a new tab), whether the AI can read it, remove. */
function Row({ icon, name, href, kind, sub, reads, state, problem, onRecheck, onRemove }: Omit<RowProps, "key">) {
  const t = useT();
  return (
    <li className="grid min-w-0 gap-1 px-3 py-2">
      <div className="flex min-w-0 items-center gap-2.5">
        <span aria-hidden="true" className={cx("shrink-0 [&_svg]:size-4", problem ? "text-warn" : "text-ink-2")}>
          {problem ? <InfoIcon /> : icon}
        </span>
        <span className="min-w-0 flex-1">
          <a href={href} target="_blank" rel="noreferrer" className="text-ink block truncate text-[13px] font-medium no-underline hover:underline">
            {name}
          </a>
          <span className="text-ink-2 flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs">
            <span className="shrink-0">{kind}</span>
            {reads !== undefined ? (
              <>
                <span aria-hidden="true">·</span>
                <span title={reads ? undefined : t("workflows.studio.res.keptHint")}>{t(reads ? "workflows.studio.res.reads" : "workflows.studio.res.kept")}</span>
              </>
            ) : null}
            {state ? (
              <>
                <span aria-hidden="true">·</span>
                {state}
              </>
            ) : null}
          </span>
        </span>
        {onRecheck ? (
          <button
            type="button"
            className="text-ink-2 hover:bg-hover hover:text-ink grid size-7 shrink-0 place-items-center rounded-full max-md:size-9"
            onClick={onRecheck}
            aria-label={t("workflows.studio.res.link.recheck")}
            title={t("workflows.studio.res.link.recheck")}
          >
            <RefreshIcon className="size-4" />
          </button>
        ) : null}
        <button
          type="button"
          className="text-ink-2 hover:bg-hover hover:text-ink grid size-7 shrink-0 place-items-center rounded-full max-md:size-9"
          onClick={onRemove}
          aria-label={t("workflows.studio.remove", { name })}
        >
          <CloseIcon className="size-4" />
        </button>
      </div>
      {problem ? <p className="text-warn m-0 pl-[1.625rem] text-xs">{problem}</p> : sub ? <p className="text-ink-2 m-0 truncate pl-[1.625rem] text-xs">{sub}</p> : null}
    </li>
  );
}

/** A link's name when none was given: the first words of what it says, ended at a word. */
function firstWords(text: string, max = 60): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 20 ? cut.lastIndexOf(" ") : max).replace(/[\s.,;:–-]+$/, "")}…`;
}
