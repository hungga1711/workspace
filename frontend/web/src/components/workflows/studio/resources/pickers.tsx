"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import { useT } from "@/lib/i18n/client";
import { btn, btnPrimary, cx, input } from "@/lib/ui";
import { CheckIcon, ChevronRightIcon, CloseIcon, FileIcon, FolderIcon, SearchIcon } from "@/components/app/icons";
import { kb } from "@/components/chat/attachments";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { Segmented } from "@/components/ui/Segmented";

/*
 * The small pickers that open under "Add a source": pages of Docs, files of the Drive, tasks, a pasted link. Each is
 * a search field over a short list; picking adds the source and keeps the picker open, so several can be added in a
 * row. A list that fails to load says so with a retry, never an empty picker.
 */

/** The frame every picker shares: a title, a close button, the picker below. */
export function Panel({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const t = useT();
  return (
    <div
      role="group"
      aria-label={title}
      className="bg-ground ring-hairline grid min-w-0 gap-2.5 rounded-xl p-3 ring-1 ring-inset"
      // Esc puts the picker away, like the dialogs around it.
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="text-ink min-w-0 flex-1 truncate text-[13px] font-semibold">{title}</span>
        <button
          type="button"
          className="text-ink-2 hover:bg-hover hover:text-ink grid size-7 shrink-0 place-items-center rounded-full max-md:size-9"
          onClick={onClose}
          aria-label={t("common.close")}
        >
          <CloseIcon className="size-4" />
        </button>
      </div>
      {children}
    </div>
  );
}

function SearchField({ value, onChange, placeholder, onEnter }: { value: string; onChange: (v: string) => void; placeholder: string; onEnter?: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <span className="relative flex min-w-0 items-center">
      <SearchIcon aria-hidden="true" className="text-ink-2 pointer-events-none absolute left-2.5 size-4" />
      <input
        ref={ref}
        className={cx(input, "pl-8")}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onEnter?.();
          }
        }}
        placeholder={placeholder}
        aria-label={placeholder}
      />
    </span>
  );
}

/** One row of a picker's list: click adds it; one already added shows a tick and does nothing. */
function Option({
  icon,
  name,
  sub,
  added,
  disabled,
  onPick,
  trailing,
}: {
  icon: React.ReactNode;
  name: string;
  sub?: string;
  added?: boolean;
  disabled?: boolean;
  onPick: () => void;
  trailing?: React.ReactNode;
}) {
  const t = useT();
  return (
    <li>
      <button
        type="button"
        disabled={added || disabled}
        onClick={onPick}
        className={cx(
          "flex min-h-9 w-full min-w-0 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13px] max-md:min-h-11",
          added || disabled ? "text-ink-2" : "text-ink hover:bg-hover",
        )}
      >
        <span aria-hidden="true" className="text-ink-2 shrink-0 [&_svg]:size-4">
          {icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate">{name}</span>
          {sub ? <span className="text-ink-2 block truncate text-xs">{sub}</span> : null}
        </span>
        {added ? (
          <span className="text-ok inline-flex shrink-0 items-center gap-1 text-xs">
            <CheckIcon className="size-3.5" />
            {t("workflows.studio.res.added")}
          </span>
        ) : (
          trailing
        )}
      </button>
    </li>
  );
}

const listBox = "bg-surface ring-hairline m-0 grid max-h-64 min-w-0 list-none content-start gap-0.5 overflow-y-auto rounded-lg p-1 ring-1 ring-inset";
const quiet = "text-ink-2 m-0 px-2 py-2 text-[13px]";

/** A read that can fail and be tried again; `key` changing reads again. */
function useRead<T>(read: () => Promise<T>, key: string) {
  const [state, setState] = useState<{ key: string; data: T | null; failed: boolean }>({ key: "", data: null, failed: false });
  const [turn, setTurn] = useState(0);
  const fn = useRef(read);
  fn.current = read;
  useEffect(() => {
    let live = true;
    fn.current()
      .then((data) => live && setState({ key, data, failed: false }))
      .catch(() => live && setState({ key, data: null, failed: true }));
    return () => {
      live = false;
    };
  }, [key, turn]);
  const current = state.key === key;
  return { data: current ? state.data : null, failed: current && state.failed, loading: !current, retry: useCallback(() => setTurn((n) => n + 1), []) };
}

function useDebounced(value: string, ms = 250) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

// ── Pages ────────────────────────────────────────────────────────────────────────────────────────────

export function PagePicker({ picked, full, onPick }: { picked: Set<string>; full: boolean; onPick: (p: { id: string; title: string }) => void }) {
  const t = useT();
  const [q, setQ] = useState("");
  const r = useRead(() => api<{ documents: { id: string; title: string }[] }>("work/docs").then((x) => x.documents), "pages");
  const words = q.trim().toLowerCase();
  const rows = (r.data ?? []).filter((p) => !words || p.title.toLowerCase().includes(words)).slice(0, 60);
  return (
    <>
      <SearchField value={q} onChange={setQ} placeholder={t("workflows.studio.res.search.pages")} />
      {r.failed ? (
        <LoadFailed what={t("workflows.studio.res.loadFailed")} onRetry={r.retry} className="px-2" />
      ) : (
        <ul className={listBox} aria-busy={r.loading}>
          {rows.map((p) => (
            <Option
              key={p.id}
              icon={<FileIcon />}
              name={p.title || t("workflows.studio.res.untitled")}
              added={picked.has(p.id)}
              disabled={full}
              onPick={() => onPick({ id: p.id, title: p.title })}
            />
          ))}
          {!r.loading && !rows.length ? <li className={quiet}>{t("workflows.studio.res.none")}</li> : null}
        </ul>
      )}
    </>
  );
}

// ── Drive ────────────────────────────────────────────────────────────────────────────────────────────

interface DriveItem {
  id: string;
  kind: "folder" | "file";
  name: string;
  size: number;
}
type Where = "recent" | "mine" | "shared";

/** Files of the workspace's Drive: recent ones first, My Drive and shared folders to walk through, or a search by name. */
export function DrivePicker({ picked, full, onPick }: { picked: Set<string>; full: boolean; onPick: (f: { id: string; name: string }) => void }) {
  const t = useT();
  const [q, setQ] = useState("");
  const [where, setWhere] = useState<Where>("recent");
  const [folder, setFolder] = useState<string | null>(null);
  const words = useDebounced(q.trim());
  const query = words ? `?q=${encodeURIComponent(words)}` : folder ? `?folder=${encodeURIComponent(folder)}` : where === "mine" ? "" : `?section=${where}`;
  const r = useRead(() => api<{ items: DriveItem[]; path?: { id: string; name: string }[] }>(`work/drive${query}`), `drive${query}`);
  const items = r.data?.items ?? [];
  const path = !words && folder ? (r.data?.path ?? []) : [];
  return (
    <>
      <SearchField value={q} onChange={setQ} placeholder={t("workflows.studio.res.search.drive")} />
      {words ? null : (
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
          <Segmented
            label={t("workflows.studio.res.drive.where")}
            size="sm"
            value={where}
            onChange={(v) => {
              setWhere(v);
              setFolder(null);
            }}
            options={(["recent", "mine", "shared"] as const).map((w) => ({ value: w, label: t(`workflows.studio.res.drive.${w}`) }))}
          />
          {path.length ? (
            <span className="text-ink-2 flex min-w-0 flex-wrap items-center gap-1 text-xs">
              <button type="button" className="hover:text-ink underline-offset-2 hover:underline" onClick={() => setFolder(null)}>
                {t(`workflows.studio.res.drive.${where}`)}
              </button>
              {path.map((p) => (
                <span key={p.id} className="flex min-w-0 items-center gap-1">
                  <ChevronRightIcon aria-hidden="true" className="size-3 shrink-0" />
                  <button type="button" className="hover:text-ink max-w-40 truncate underline-offset-2 hover:underline" onClick={() => setFolder(p.id)}>
                    {p.name}
                  </button>
                </span>
              ))}
            </span>
          ) : null}
        </div>
      )}
      {r.failed ? (
        <LoadFailed what={t("workflows.studio.res.loadFailed")} onRetry={r.retry} className="px-2" />
      ) : (
        <ul className={listBox} aria-busy={r.loading}>
          {items.map((it) =>
            it.kind === "folder" ? (
              <Option
                key={it.id}
                icon={<FolderIcon />}
                name={it.name}
                onPick={() => setFolder(it.id)}
                trailing={<ChevronRightIcon aria-hidden="true" className="text-ink-2 size-4 shrink-0" />}
              />
            ) : (
              <Option
                key={it.id}
                icon={<FileIcon />}
                name={it.name}
                sub={kb(it.size)}
                added={picked.has(it.id)}
                disabled={full}
                onPick={() => onPick({ id: it.id, name: it.name })}
              />
            ),
          )}
          {!r.loading && !items.length ? <li className={quiet}>{t(words ? "workflows.studio.res.none" : "workflows.studio.res.drive.emptyFolder")}</li> : null}
        </ul>
      )}
    </>
  );
}

// ── Tasks ────────────────────────────────────────────────────────────────────────────────────────────

interface TaskRef {
  id: string;
  code: string;
  title: string;
}
const CODE = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

/**
 * Another task to learn from: the reader's own tasks to start with, the workspace's search as they type, and a pasted
 * code (T-12) resolved on Enter. A search hit carries no code, so it is read once when picked.
 */
export function TaskPicker({ picked, full, onPick }: { picked: Set<string>; full: boolean; onPick: (t: TaskRef) => void }) {
  const t = useT();
  const [q, setQ] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const words = useDebounced(q.trim());
  const mine = useRead(() => api<{ tasks: TaskRef[] }>("work/tasks").then((x) => x.tasks), "tasks");
  // Search is extra: when it fails the reader's own tasks still filter.
  const found = useRead(
    () =>
      words.length < 2
        ? Promise.resolve([] as { id: string; title: string }[])
        : api<{ hits: { entity_type: string; entity_id: string; title: string }[] }>(`chat/search?q=${encodeURIComponent(words)}`)
            .then((x) => x.hits.filter((h) => h.entity_type === "task").map((h) => ({ id: h.entity_id, title: h.title })))
            .catch(() => []),
    `search:${words}`,
  );
  const lower = words.toLowerCase();
  const own = (mine.data ?? []).filter((x) => !lower || x.title.toLowerCase().includes(lower) || x.code.toLowerCase().includes(lower)).slice(0, 30);
  const more = (found.data ?? []).filter((h) => !own.some((x) => x.id === h.id)).slice(0, 20);
  const resolve = async (ref: string) => {
    setNote(null);
    try {
      const r = await api<{ task?: TaskRef } & Partial<TaskRef>>(`work/tasks/${encodeURIComponent(ref)}`);
      const task = r.task ?? (r.id && r.code ? { id: r.id, code: r.code, title: r.title ?? "" } : null);
      if (!task) throw new Error("not found");
      onPick({ id: task.id, code: task.code, title: task.title });
    } catch {
      setNote(t("workflows.studio.res.tasks.notFound"));
    }
  };
  return (
    <>
      <SearchField
        value={q}
        onChange={(v) => {
          setQ(v);
          setNote(null);
        }}
        placeholder={t("workflows.studio.res.search.tasks")}
        onEnter={() => CODE.test(q.trim()) && !full && void resolve(q.trim())}
      />
      {note ? (
        <p role="alert" className="text-block m-0 px-2 text-xs">
          {note}
        </p>
      ) : null}
      {mine.failed && !more.length ? (
        <LoadFailed what={t("workflows.studio.res.loadFailed")} onRetry={mine.retry} className="px-2" />
      ) : (
        <ul className={listBox} aria-busy={mine.loading || found.loading} aria-label={t("workflows.studio.res.tasks.mine")}>
          {own.map((x) => (
            <Option key={x.id} icon={<CheckIcon />} name={x.title} sub={x.code} added={picked.has(x.id)} disabled={full} onPick={() => onPick(x)} />
          ))}
          {more.map((h) => (
            <Option key={h.id} icon={<CheckIcon />} name={h.title} added={picked.has(h.id)} disabled={full} onPick={() => void resolve(h.id)} />
          ))}
          {!mine.loading && !found.loading && !own.length && !more.length ? <li className={quiet}>{t("workflows.studio.res.none")}</li> : null}
        </ul>
      )}
    </>
  );
}

// ── Links ────────────────────────────────────────────────────────────────────────────────────────────

/** Every web address in what was typed or pasted (several lines, or addresses separated by spaces). */
export const addressesIn = (text: string) => [...new Set(text.split(/\s+/).filter((x) => /^https?:\/\/[^\s.]+\.\S+$/i.test(x)))];

export function LinkForm({ full, onAdd }: { full: boolean; onAdd: (links: { url: string; title: string }[]) => void }) {
  const t = useT();
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [bad, setBad] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const add = (text = url) => {
    const found = addressesIn(text.trim());
    if (!found.length) return setBad(!!text.trim());
    // A name belongs to one link; several pasted at once are named from what they turn out to be.
    onAdd(found.map((u) => ({ url: u.slice(0, 1000), title: found.length === 1 ? name.trim().slice(0, 200) : "" })));
    setUrl("");
    setName("");
    setBad(false);
    ref.current?.focus();
  };
  return (
    <form
      className="grid min-w-0 gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        add();
      }}
    >
      <div className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_auto]">
        <input
          ref={ref}
          className={input}
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            setBad(false);
          }}
          onPaste={(e) => {
            // Several addresses pasted together are added at once; one is left in the field to be named.
            const text = e.clipboardData.getData("text");
            if (addressesIn(text).length > 1) {
              e.preventDefault();
              add(text);
            }
          }}
          placeholder={t("workflows.studio.res.link.urlPh")}
          aria-label={t("workflows.studio.res.link.url")}
          aria-invalid={bad}
          inputMode="url"
          autoComplete="off"
          disabled={full}
        />
        <input
          className={input}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("workflows.studio.res.link.name")}
          aria-label={t("workflows.studio.res.link.name")}
          maxLength={200}
          disabled={full}
        />
        <button type="submit" className={cx(url.trim() ? btnPrimary : btn, "justify-center")} disabled={full || !url.trim()}>
          {t("workflows.studio.res.link.add")}
        </button>
      </div>
      <p className={cx("m-0 text-xs", bad ? "text-block" : "text-ink-2")} role={bad ? "alert" : undefined}>
        {t(bad ? "workflows.studio.res.link.invalid" : "workflows.studio.res.link.hint")}
      </p>
    </form>
  );
}
