"use client";

import Link from "next/link";
import { PickerField } from "@/components/admin/PickerField";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/client";
import { useFormat, useLocale, useT } from "@/lib/i18n/client";
import { Avatar, useDirectory } from "@/lib/people";
import { btn, btnGhost, btnPrimary, btnSm, cx, input } from "@/lib/ui";
import { Modal } from "@/components/ui/Modal";
import { Field } from "@/components/ui/bits";
import { Segmented } from "@/components/ui/Segmented";
import { ArrowRightIcon, CheckIcon, FileIcon, FolderIcon, LockIcon, MoreIcon, PlusIcon, SearchIcon, SettingsIcon, StarIcon } from "@/components/app/icons";
import { EmptyState } from "@/components/ui/EmptyState";
import { DocsHeader } from "./DocsHeader";
import { EditSpaceModal, NewSpaceModal, type SpaceDto } from "./SpaceModal";
import { Menu } from "@/components/ui/Menu";
import { NO_TONE, deptTone } from "@/lib/identity";
import { TEMPLATE_KEYS, templateHtml, type TemplateKey } from "./templates";
import { docHref } from "@/lib/links";
import { card } from "@/components/ui/Bento";
import { SpotArea } from "@/components/ui/SpotArea";

/** Picker value for "my personal pages" (no space): options need a non-empty value. */
const PERSONAL = "__personal";

export type Space = SpaceDto;
export interface PageRow {
  id: string;
  title: string;
  emoji: string;
  spaceId: string | null;
  lastEditorId: string;
  updatedAt: string;
  ownerId?: string;
  visibility?: string;
}
export interface DocsHomeData {
  spaces: Space[];
  starred: PageRow[];
  recent: PageRow[];
  updated: PageRow[];
}

/**
 * Docs home: search, the spaces as cards (what each is for, how many pages), then one
 * list of pages with Recent / Starred / Updated tabs. A space's home page is the space itself, so it
 * never shows twice as an ordinary page.
 */
export function DocsHome({ data, label, labelled, openNew }: { data: DocsHomeData; label?: string; labelled?: PageRow[]; openNew?: boolean }) {
  const t = useT();
  const router = useRouter();
  const [newSpace, setNewSpace] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  // "Trang mới" from a space's menu starts in that space.
  const [newPage, setNewPage] = useState<boolean | string>(!!openNew);
  const live = data.spaces.filter((s) => !s.archived);
  const archived = data.spaces.filter((s) => s.archived);
  const homes = new Set(data.spaces.map((s) => s.homeId).filter(Boolean));
  const lists = {
    recent: data.recent.filter((p) => !homes.has(p.id)),
    starred: data.starred,
    updated: data.updated.filter((p) => !homes.has(p.id)),
  };
  const [tab, setTab] = useState<keyof typeof lists>(lists.recent.length ? "recent" : "updated");
  const [q, setQ] = useState("");
  const space = (id: string | null) => data.spaces.find((s) => s.id === id);
  const rows = label ? (labelled ?? []) : lists[tab];
  return (
    <div>
      {/* The header keeps its own 20px margin, like every other tab; the sections below are spaced by the grid. */}
      <DocsHeader
        active="pages"
        actions={
          <>
            <button type="button" className={btnPrimary} onClick={() => setNewPage(true)}>
              <PlusIcon className="size-4" />
              {t("docs.home.newPage")}
            </button>
          </>
        }
      />

      {/* One pointer listener lights whichever space card is under it (Home's spot cards). */}
      <SpotArea className="grid gap-7">
        {/* Search first: most visits are "find that page". */}
        <form
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            if (q.trim()) router.push(`/app/search?type=document&q=${encodeURIComponent(q.trim())}`);
          }}
        >
          <label className="bg-surface shadow-card hover:shadow-lift ease-out-soft flex h-12 cursor-text items-center gap-3 rounded-xl px-4 transition-shadow duration-300 focus-within:shadow-[0_0_0_1px_var(--accent),0_0_0_4px_var(--accent-wash)]">
            <SearchIcon className="text-ink-2 size-[18px] shrink-0" />
            <input
              className="text-ink placeholder:text-ink-2 min-w-0 flex-1 bg-transparent text-[15px] outline-none max-md:text-base"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t("docs.home.search")}
              aria-label={t("docs.home.search")}
            />
            <kbd className="bg-ground ring-hairline text-ink-2 rounded-md px-1.5 font-sans text-[11px] font-medium leading-5 ring-1 ring-inset max-md:hidden">↵</kbd>
          </label>
        </form>

        <section aria-labelledby="spaces-h" className="grid gap-2.5">
          <div className="flex items-center gap-2">
            <h2 id="spaces-h" className="m-0 text-[15px]/6 font-semibold tracking-[-0.01em]">
              {t("docs.home.spaces")} <span className="text-ink-2 font-normal tabular-nums">{data.spaces.length || null}</span>
            </h2>
            {data.spaces.length ? (
              <button type="button" onClick={() => setNewSpace(true)} className={cx(btnGhost, btnSm, "text-ink-2 ml-auto")}>
                <PlusIcon className="size-4" />
                {t("docs.home.newSpace")}
              </button>
            ) : null}
          </div>
          {data.spaces.length ? null : (
            <EmptyState
              kind="none"
              title={t("docs.home.firstSpace")}
              action={
                <button type="button" className={btn} onClick={() => setNewSpace(true)}>
                  <PlusIcon className="size-4" />
                  {t("docs.home.newSpace")}
                </button>
              }
            />
          )}
          <SpaceCards spaces={live} onEdit={setEditing} onNewPage={(id) => setNewPage(id)} />
          {archived.length ? (
            <details className="group mt-1">
              <summary className="text-ink-2 hover:text-ink cursor-pointer select-none text-[13px] font-medium">
                {t("docs.space.archivedSection")} <span className="tabular-nums">({archived.length})</span>
              </summary>
              <div className="mt-2.5">
                <SpaceCards spaces={archived} onEdit={setEditing} onNewPage={(id) => setNewPage(id)} />
              </div>
            </details>
          ) : null}
        </section>

        {!label && !lists.recent.length && !lists.starred.length && !lists.updated.length ? (
          <EmptyState
            kind="none"
            title={t("docs.home.noPages")}
            action={
              <button type="button" className={btn} onClick={() => setNewPage(true)}>
                <PlusIcon className="size-4" />
                {t("docs.home.newPage")}
              </button>
            }
          />
        ) : (
          <section aria-labelledby="pages-h" className="grid gap-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <h2 id="pages-h" className="m-0 text-[15px]/6 font-semibold tracking-[-0.01em]">
                {label ? t("docs.home.withLabel", { label }) : t("docs.home.pages")}
              </h2>
              {label ? (
                <Link href="/app/work/docs" className="text-sm">
                  {t("docs.home.clearLabel")}
                </Link>
              ) : (
                <Segmented
                  size="sm"
                  label={t("docs.home.pages")}
                  value={tab}
                  onChange={setTab}
                  options={(["recent", "starred", "updated"] as const).map((k) => ({
                    value: k,
                    label: t(`docs.home.${k}`),
                    icon: k === "starred" ? <StarIcon /> : undefined,
                    count: lists[k].length,
                  }))}
                />
              )}
            </div>
            {rows.length ? (
              <PageRows rows={rows} space={space} />
            ) : (
              <EmptyState kind="none" compact title={tab === "starred" ? t("docs.home.noStarred") : tab === "recent" ? t("docs.home.noRecent") : t("docs.home.noUpdates")} />
            )}
          </section>
        )}
      </SpotArea>
      {newSpace ? <NewSpaceModal onClose={() => setNewSpace(false)} /> : null}
      {editing ? <EditSpaceModal spaceKey={editing} onClose={() => setEditing(null)} /> : null}
      {newPage ? <NewPageModal spaces={live} initialSpace={typeof newPage === "string" ? newPage : undefined} onClose={() => setNewPage(false)} /> : null}
    </div>
  );
}

function NewPageModal({ spaces, initialSpace, onClose }: { spaces: Space[]; initialSpace?: string; onClose: () => void }) {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const [space, setSpace] = useState(initialSpace ?? spaces[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [template, setTemplate] = useState<TemplateKey>("blank");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const html = templateHtml(template, locale);
      // No title typed: the page opens with an empty title field to type into, not a template name to delete first.
      const d = await api<{ id: string }>("work/docs", {
        method: "POST",
        body: { title: title.trim(), draft: true, content: html, format: "html", ...(space ? { spaceId: space } : { visibility: "private" }) },
      });
      router.push(`${docHref(d)}?edit=1&new=1`);
    } catch {
      setError(t("docs.page.saveFailed"));
      setBusy(false);
    }
  };
  return (
    <Modal
      title={t("docs.home.newPage")}
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className={btn} onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="button" className={btnPrimary} disabled={busy} onClick={() => void create()}>
            {t("docs.page.createAndEdit")}
          </button>
        </>
      }
    >
      <div className="grid gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("docs.page.title")} error={error}>
            <input
              className={input}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void create();
                }
              }}
              placeholder={t("docs.page.untitled")}
              autoFocus
            />
          </Field>
          <PickerField
            label={t("docs.page.in")}
            value={space || PERSONAL}
            onChange={(v) => setSpace(v === PERSONAL ? "" : v)}
            options={[
              ...spaces.map((s) => ({ value: s.id, label: s.name, icon: s.icon ? <span aria-hidden="true">{s.icon}</span> : undefined })),
              { value: PERSONAL, label: t("docs.home.personal") },
            ]}
          />
        </div>
        <fieldset className="m-0 grid gap-2 border-0 p-0">
          <legend className="mb-1 text-sm font-medium">{t("docs.page.template")}</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {TEMPLATE_KEYS.map((key) => (
              <label
                key={key}
                className={cx(
                  "has-[:focus-visible]:ring-ink-2 relative flex cursor-pointer items-start gap-2 rounded-lg border p-3 text-sm transition-colors has-[:focus-visible]:ring-2",
                  template === key ? "border-ink bg-hover" : "border-hairline hover:bg-hover/60",
                )}
              >
                {/* A card choice: the radio stays for keyboards and screen readers, the border and check show it. */}
                <input type="radio" name="tpl" className="sr-only" checked={template === key} onChange={() => setTemplate(key)} />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{t(`docs.tpl.${key}`)}</span>
                  <span className="text-ink-2 block text-sm">{t(`docs.tpl.${key}Hint`)}</span>
                </span>
                <CheckIcon className={cx("text-ink mt-0.5 size-4 shrink-0", template === key ? "opacity-100" : "opacity-0")} aria-hidden="true" />
              </label>
            ))}
          </div>
        </fieldset>
      </div>
    </Modal>
  );
}

/** Pages by when they were last edited: today, the last 7 days, before. */
function bucket(iso: string, now: number): "today" | "week" | "older" {
  const d = new Date(iso);
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (d.getTime() >= start.getTime()) return "today";
  return now - d.getTime() < 7 * 86400e3 ? "week" : "older";
}

/**
 * The pages: one quiet list grouped by when each page changed. A page is a document
 * glyph, its title and where it lives; the space's colour is only a small dot, so colour never competes with titles.
 */
/** Where a page outside every space lives, said truthfully: only the caller's own private pages are "my private pages". */
function looseLabel(p: PageRow, me: string): "docs.home.personal" | "docs.home.sharedWithMe" | "docs.home.noSpace" {
  if (p.visibility && p.visibility !== "private") return "docs.home.noSpace";
  if (p.ownerId && p.ownerId !== me) return "docs.home.sharedWithMe";
  return "docs.home.personal";
}

function PageRows({ rows, space }: { rows: PageRow[]; space: (id: string | null) => Space | undefined }) {
  const t = useT();
  const { ago } = useFormat();
  const dir = useDirectory();
  const now = Date.now();
  const groups = (["today", "week", "older"] as const).map((k) => ({ k, items: rows.filter((p) => bucket(p.updatedAt, now) === k) })).filter((g) => g.items.length);
  return (
    <div className="bg-surface shadow-card overflow-hidden rounded-xl">
      {groups.map((g, gi) => (
        <div key={g.k} className={cx(gi > 0 && "border-divider border-t")}>
          <h3 className="text-ink-2 m-0 px-4 pb-1 pt-3.5 text-xs font-medium uppercase tracking-[0.08em]">{t(`docs.home.when.${g.k}`)}</h3>
          <ul className="m-0 list-none px-1.5 pb-1.5">
            {g.items.map((p) => {
              const sp = space(p.spaceId);
              const tone = sp ? deptTone(sp.name) : NO_TONE;
              return (
                <li key={p.id}>
                  <Link
                    href={docHref(p)}
                    title={p.title || t("docs.page.untitled")}
                    className="hover:bg-hover focus-visible:bg-hover group flex min-h-12 min-w-0 cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 no-underline transition-colors duration-150 focus-visible:outline-none"
                  >
                    <span
                      aria-hidden="true"
                      className="bg-ground ring-hairline text-ink-2 group-hover:text-ink grid size-8 shrink-0 place-items-center rounded-[9px] ring-1 ring-inset transition-colors"
                    >
                      <FileIcon className="size-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="text-ink block truncate text-sm font-medium">{p.title || t("docs.page.untitled")}</span>
                      <span className="text-ink-2 flex min-w-0 items-center gap-1.5 text-xs">
                        <span className={cx(tone.fill, "size-1.5 shrink-0 rounded-full")} aria-hidden="true" />
                        <span className="truncate">{sp ? sp.name : t(looseLabel(p, dir.me))}</span>
                      </span>
                    </span>
                    <span className="text-ink-2 hidden shrink-0 items-center gap-1.5 text-xs md:flex">
                      <Avatar id={p.lastEditorId} size="xs" />
                      <span className="max-w-32 truncate">{dir.name(p.lastEditorId)}</span>
                    </span>
                    <span className="text-ink-2 w-20 shrink-0 text-right text-xs tabular-nums">{ago(p.updatedAt)}</span>
                    <ArrowRightIcon
                      aria-hidden="true"
                      className="text-ink-2 group-hover:text-ink size-4 shrink-0 transition-transform duration-200 group-hover:translate-x-0.5 max-md:hidden"
                    />
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

/**
 * One card per space: white, hairline, generous padding. A folder glyph on the space's
 * pale wash says "this opens"; the name leads, then what it is for, then pages and who may read it. On hover the edge
 * darkens and an arrow appears.
 */
function SpaceCards({ spaces, onEdit, onNewPage }: { spaces: Space[]; onEdit: (key: string) => void; onNewPage: (id: string) => void }) {
  const t = useT();
  const router = useRouter();
  if (!spaces.length) return null;
  return (
    <ul className="m-0 grid list-none gap-3 p-0 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
      {spaces.map((s) => {
        const tone = deptTone(s.name);
        const home = s.homeId ? `/app/work/docs/${s.homeId}` : "/app/work/docs";
        return (
          <li
            key={s.id}
            // A Home card (lift + pointer light); the one whose menu is open rises above its neighbours.
            className={cx(card, "group flex min-h-40 cursor-pointer flex-col rounded-xl p-5 has-[[aria-expanded=true]]:z-20", s.archived && "opacity-70")}
          >
            <div className="flex items-start justify-between gap-3">
              <span aria-hidden="true" className={cx(tone.wash, tone.text, "ring-current/10 grid size-9 shrink-0 place-items-center rounded-md ring-1 ring-inset")}>
                <FolderIcon className="size-[18px]" />
              </span>
              <span className="relative z-10 -mr-2 -mt-1.5 flex items-center">
                <ArrowRightIcon
                  className="text-ink-2 mr-1 size-4 -translate-x-1 opacity-0 transition-[opacity,transform] duration-200 group-hover:translate-x-0 group-hover:opacity-100"
                  aria-hidden="true"
                />
                <Menu
                  label={t("docs.space.menu", { name: s.name })}
                  items={[
                    { label: t("docs.space.open"), icon: <FileIcon />, onSelect: () => router.push(home) },
                    ...(!s.archived ? [{ label: t("docs.space.newPageIn"), icon: <PlusIcon />, onSelect: () => onNewPage(s.id) }] : []),
                    ...(s.canManage ? [{ label: t("docs.space.settings"), icon: <SettingsIcon />, onSelect: () => onEdit(s.key) }] : []),
                  ]}
                  trigger={
                    <span className="text-ink-2 hover:bg-hover hover:text-ink grid size-8 place-items-center rounded-md">
                      <MoreIcon className="size-4" />
                    </span>
                  }
                />
              </span>
            </div>
            <Link
              href={home}
              className="text-ink mt-4 block truncate text-base font-semibold tracking-[-0.015em] no-underline after:absolute after:inset-0 after:z-[1] after:rounded-xl after:content-['']"
            >
              {s.name}
            </Link>
            <p className="text-ink-2 m-0 mt-1 line-clamp-2 text-sm/5">{s.description || t("docs.home.noDescription")}</p>
            <p className="text-ink-2 m-0 mt-auto flex items-center gap-2 pt-4 text-xs">
              <span className="tabular-nums">{t("docs.home.pageCount", { count: s.pages ?? 0 })}</span>
              <span aria-hidden="true">·</span>
              {s.visibility === "restricted" ? (
                <span className="inline-flex items-center gap-1">
                  <LockIcon className="size-3" />
                  {t("docs.space.memberCount", { count: s.members?.length ?? 0 })}
                </span>
              ) : (
                <span>{t("docs.space.visibilityAll")}</span>
              )}
              {s.archived ? <span className="ml-auto">{t("docs.space.archived")}</span> : null}
            </p>
          </li>
        );
      })}
    </ul>
  );
}
