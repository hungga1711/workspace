"use client";

import { PersonTrigger } from "@/components/chat/PersonTrigger";
import Link from "next/link";
import { Checkbox } from "@/components/ui/Checkbox";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import { useFormat, useT } from "@/lib/i18n/client";
import { Avatar, useDirectory } from "@/lib/people";
import { btn, btnPrimary, cx, input } from "@/lib/ui";
import { EmptyState } from "@/components/ui/EmptyState";
import { Segmented } from "@/components/ui/Segmented";
import { DocsHeader } from "@/components/docs/DocsHeader";
import { Modal } from "@/components/ui/Modal";
import { Field } from "@/components/ui/bits";
import { Menu } from "@/components/ui/Menu";
import { PeoplePicker } from "@/components/chat/NewConversation";
import { DownloadIcon, GridIcon, SearchIcon, FileIcon, FolderIcon, ListIcon, MoreIcon, PlusIcon, StarIcon, TrashIcon, UsersIcon } from "@/components/app/icons";

export interface DriveItem {
  id: string;
  kind: "folder" | "file";
  name: string;
  parentId: string | null;
  ownerId: string;
  fileId: string | null;
  size: number;
  contentType: string;
  visibility: "private" | "workspace";
  sharedWith: string[];
  editors: string[];
  trashedAt: string | null;
  updatedAt: string;
  starred: boolean;
}
export interface DriveData {
  items: DriveItem[];
  path: { id: string; name: string }[];
  canEdit: boolean;
  usedBytes: number;
}
type Section = "mine" | "shared" | "recent" | "starred" | "trash";

const size = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const kindOf = (it: DriveItem) =>
  it.kind === "folder"
    ? "folder"
    : it.contentType.startsWith("image/")
      ? "image"
      : it.contentType === "application/pdf"
        ? "pdf"
        : it.contentType.includes("sheet") || it.contentType.includes("excel") || it.contentType === "text/csv"
          ? "sheet"
          : it.contentType.includes("presentation") || it.contentType.includes("powerpoint")
            ? "slides"
            : it.contentType.startsWith("video/")
              ? "video"
              : "doc";
const TINT: Record<string, string> = {
  folder: "bg-hover text-ink",
  image: "bg-hover text-ink",
  pdf: "bg-block-wash text-block",
  sheet: "bg-ok-wash text-ok",
  slides: "bg-warn-wash text-warn",
  video: "bg-brand-wash text-brand-text",
  doc: "bg-brand-wash text-brand-text",
};

/**
 * Drive like Google Drive: My Drive, shared with me, recent, starred and trash; folders with a path;
 * upload (button or drag and drop), preview images and PDFs, rename, move, share, star, trash.
 */
export function DriveView({ data, section, folder, q, quick }: { data: DriveData; section: Section; folder?: string; q?: string; quick?: DriveItem[] }) {
  const t = useT();
  const { ago } = useFormat();
  const dir = useDirectory();
  const router = useRouter();
  const [layout, setLayout] = useState<"list" | "grid">("list");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [naming, setNaming] = useState<{ item: DriveItem | null } | null>(null);
  const [sharing, setSharing] = useState<DriveItem | null>(null);
  const [moving, setMoving] = useState<DriveItem | null>(null);
  const [preview, setPreview] = useState<DriveItem | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const href = (p: Record<string, string | undefined>) =>
    `/app/work/docs?view=files${Object.entries(p)
      .map(([k, v]) => (v ? `&${k}=${encodeURIComponent(v)}` : ""))
      .join("")}`;
  const parentId = folder ?? null;
  const canAdd = section === "mine" && data.canEdit && !q;

  const uploadAll = async (files: FileList | File[]) => {
    setError(null);
    for (const f of Array.from(files)) {
      setBusy(t("drive.uploading", { name: f.name }));
      try {
        const u = await api<{ itemId: string; fileId: string; uploadUrl: string }>("work/drive/uploads", {
          method: "POST",
          body: { name: f.name, contentType: f.type || "application/octet-stream", size: f.size, parentId },
        });
        const put = await fetch(u.uploadUrl, { method: "PUT", headers: { "content-type": f.type || "application/octet-stream" }, body: f });
        if (!put.ok) throw new Error("put");
        await api(`work/files/${u.fileId}/confirm`, { method: "POST" });
        await api(`work/drive/items/${u.itemId}/finish`, { method: "POST" });
      } catch (e) {
        const b = (e as { body?: { message?: string }; status?: number }).body;
        setError(
          b?.message?.includes("type") ? t("drive.badType", { name: f.name }) : b?.message?.includes("size") ? t("drive.tooBig") : t("drive.uploadFailed", { name: f.name }),
        );
      }
    }
    setBusy(null);
    router.refresh();
  };
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      router.refresh();
    } catch {
      setError(t("drive.failed"));
    }
  };
  const open = (it: DriveItem) => {
    if (it.kind === "folder") router.push(href({ folder: it.id }));
    else if (["image", "video"].includes(kindOf(it))) setPreview(it);
    else if (kindOf(it) === "pdf") window.open(`/files/${it.fileId}`, "_blank", "noopener");
    else window.location.assign(`/files/${it.fileId}`);
  };
  const actions = (it: DriveItem) =>
    section === "trash"
      ? [
          { label: t("drive.restore"), onSelect: () => void act(() => api(`work/drive/items/${it.id}/trash`, { method: "POST", body: { trashed: false } })) },
          {
            label: t("drive.deleteForever"),
            danger: true,
            onSelect: () => {
              if (window.confirm(t("drive.confirmPurge", { name: it.name }))) void act(() => api(`work/drive/items/${it.id}`, { method: "DELETE" }));
            },
          },
        ]
      : [
          ...(it.kind === "file" ? [{ label: t("drive.download"), icon: <DownloadIcon />, onSelect: () => window.location.assign(`/files/${it.fileId}`) }] : []),
          {
            label: t(it.starred ? "drive.unstar" : "drive.star"),
            icon: <StarIcon />,
            onSelect: () => void act(() => api(`work/drive/items/${it.id}`, { method: "PATCH", body: { starred: !it.starred } })),
          },
          ...(it.ownerId === dir.me ? [{ label: t("drive.share"), icon: <UsersIcon />, onSelect: () => setSharing(it) }] : []),
          { label: t("drive.rename"), onSelect: () => setNaming({ item: it }) },
          { label: t("drive.move"), onSelect: () => setMoving(it) },
          ...(it.ownerId === dir.me
            ? [
                {
                  label: t("drive.trash"),
                  icon: <TrashIcon />,
                  danger: true,
                  onSelect: () => void act(() => api(`work/drive/items/${it.id}/trash`, { method: "POST", body: { trashed: true } })),
                },
              ]
            : []),
        ];
  // Files show their type the way people say it (PDF, XLSX, PNG…), tinted by kind, so a folder of mixed files scans at a glance.
  const icon = (it: DriveItem, big = false) => {
    const ext = it.kind === "file" ? (/\.([a-z0-9]{1,5})$/i.exec(it.name)?.[1] ?? "").toUpperCase() : "";
    return (
      <span className={cx("grid shrink-0 place-items-center rounded-md", big ? "size-12" : "size-8", TINT[kindOf(it)])} aria-hidden="true">
        {it.kind === "folder" ? (
          <FolderIcon className={big ? "size-6" : "size-4"} />
        ) : ext ? (
          <span className={cx("font-mono font-bold tracking-tight", big ? "text-xs" : ext.length > 3 ? "text-[8.5px]" : "text-[9.5px]")}>{ext}</span>
        ) : (
          <FileIcon className={big ? "size-6" : "size-4"} />
        )}
      </span>
    );
  };
  const nav = (key: Section, label: string) => (
    <Link
      href={href({ section: key === "mine" ? undefined : key })}
      aria-current={section === key && !folder && !q ? "page" : undefined}
      className={cx(
        "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm no-underline",
        section === key && !folder ? "bg-brand-wash text-ink font-semibold" : "text-ink-2 hover:bg-hover hover:text-ink",
      )}
    >
      {label}
    </Link>
  );

  return (
    <>
      <DocsHeader
        active="files"
        actions={
          canAdd ? (
            <Menu
              label={t("drive.new")}
              align="right"
              items={[
                { label: t("drive.newFolder"), icon: <FolderIcon />, onSelect: () => setNaming({ item: null }) },
                { label: t("drive.upload"), icon: <PlusIcon />, onSelect: () => fileInput.current?.click() },
              ]}
              trigger={
                <span className={btnPrimary}>
                  <PlusIcon className="size-4" />
                  {t("drive.new")}
                </span>
              }
            />
          ) : null
        }
      />
      <div
        className="grid gap-6 lg:grid-cols-[200px_minmax(0,1fr)]"
        onDragOver={(e) => {
          if (!canAdd || !e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) setDragOver(false);
        }}
        onDrop={(e) => {
          if (!canAdd) return;
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files.length) void uploadAll(e.dataTransfer.files);
        }}
      >
        <aside className="grid content-start gap-3">
          {canAdd ? null : (
            <Link href={href({})} className={cx(btn, "justify-center no-underline")}>
              {t("drive.backToMine")}
            </Link>
          )}
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => e.target.files && void uploadAll(e.target.files)} aria-label={t("drive.upload")} />
          <nav aria-label={t("drive.sections")} className="grid gap-0.5">
            {nav("mine", t("drive.mine"))}
            {nav("shared", t("drive.shared"))}
            {nav("recent", t("drive.recent"))}
            {nav("starred", t("drive.starred"))}
            {nav("trash", t("drive.trashSection"))}
          </nav>
          <p className="text-ink-2 border-hairline m-0 border-t px-2.5 pt-3 text-xs tabular-nums">{t("drive.used", { used: size(data.usedBytes) })}</p>
        </aside>
        <section aria-label={t("drive.title")} className={cx("min-w-0 rounded-lg", dragOver && "ring-ink-2 bg-hover/60 ring-offset-ground ring-2 ring-offset-4")}>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <nav aria-label={t("drive.path")} className="flex min-w-0 flex-1 flex-wrap items-center gap-1 text-sm font-semibold">
              <Link href={href({ section: section === "mine" ? undefined : section })} className="text-ink no-underline hover:underline">
                {q ? t("drive.results", { q }) : t(`drive.${section === "trash" ? "trashSection" : section}`)}
              </Link>
              {data.path.map((p) => (
                <span key={p.id} className="flex items-center gap-1">
                  <span className="text-ink-2" aria-hidden="true">
                    ›
                  </span>
                  <Link href={href({ folder: p.id })} className="text-ink no-underline hover:underline">
                    {p.name}
                  </Link>
                </span>
              ))}
            </nav>
            <form action="/app/work/docs" className="relative flex" role="search">
              <input type="hidden" name="view" value="files" />
              <SearchIcon className="text-ink-2 pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2" />
              <input
                name="q"
                type="text"
                enterKeyHint="search"
                defaultValue={q}
                className={cx(input, "h-8 min-h-0 w-full pl-8 sm:w-56")}
                placeholder={t("drive.search")}
                aria-label={t("drive.search")}
              />
            </form>
            <Segmented
              size="sm"
              label={t("drive.layout")}
              value={layout}
              onChange={setLayout}
              options={[
                { value: "list", label: t("drive.list"), icon: <ListIcon />, iconOnly: true },
                { value: "grid", label: t("drive.grid"), icon: <GridIcon />, iconOnly: true },
              ]}
            />
          </div>
          {busy ? (
            <p role="status" className="text-ink-2 m-0 mb-2 text-sm">
              {busy}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="bg-block-wash text-block m-0 mb-2 rounded-md px-3 py-2 text-sm">
              {error}
            </p>
          ) : null}
          {quick?.length ? (
            <section aria-labelledby="quick-h" className="mb-4 grid gap-2">
              <h2 id="quick-h" className="text-ink-2 m-0 text-sm font-semibold">
                {t("drive.quick")}
              </h2>
              <ul className="m-0 grid list-none grid-cols-2 gap-3 p-0 lg:grid-cols-4">
                {quick.map((it) => (
                  <li key={it.id}>
                    <button
                      type="button"
                      onClick={() => open(it)}
                      className="bg-surface border-hairline hover:bg-hover/50 flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors"
                    >
                      {icon(it)}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{it.name}</span>
                        <span className="text-ink-2 block text-xs">{ago(it.updatedAt)}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {data.items.length === 0 ? (
            <EmptyState
              kind={q ? "filtered" : "none"}
              title={t(section === "trash" ? "drive.emptyTrash" : q ? "drive.noResults" : "drive.empty")}
              hint={canAdd && !q ? t("drive.emptyHint") : undefined}
            />
          ) : layout === "grid" ? (
            <ul className="m-0 grid list-none grid-cols-2 gap-3 p-0 sm:grid-cols-3 xl:grid-cols-5">
              {data.items.map((it) => (
                <li key={it.id} className="bg-surface border-hairline hover:bg-hover/50 group relative rounded-lg border p-3 transition-colors">
                  <button type="button" onDoubleClick={() => open(it)} onClick={() => it.kind === "folder" && open(it)} className="grid w-full justify-items-start gap-2 text-left">
                    {icon(it, true)}
                    <span className="w-full truncate text-sm font-medium">{it.name}</span>
                    <span className="text-ink-2 text-xs">{it.kind === "file" ? size(it.size) : ago(it.updatedAt)}</span>
                  </button>
                  <span className="absolute right-2 top-2">
                    <Menu
                      label={t("drive.actions", { name: it.name })}
                      items={actions(it)}
                      trigger={
                        <span className="text-ink-2 hover:bg-hover grid size-7 place-items-center rounded-md">
                          <MoreIcon className="size-4" />
                        </span>
                      }
                    />
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="bg-surface border-hairline overflow-x-auto rounded-xl border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-ink-2 border-hairline h-10 border-b text-left">
                    <th className="px-3 py-2 font-medium">{t("drive.name")}</th>
                    <th className="hidden px-3 py-2 font-medium md:table-cell">{t("drive.owner")}</th>
                    <th className="hidden px-3 py-2 font-medium sm:table-cell">{t("drive.modified")}</th>
                    <th className="px-3 py-2 text-right font-medium">{t("drive.size")}</th>
                    <th className="w-10" />
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((it) => (
                    <tr key={it.id} className="border-hairline hover:bg-hover/50 border-b transition-colors last:border-0" onDoubleClick={() => open(it)}>
                      <td className="px-3 py-2.5">
                        <button type="button" onClick={() => open(it)} className="text-ink flex min-w-0 items-center gap-2.5 text-left font-medium">
                          {icon(it)}
                          <span className="truncate">{it.name}</span>
                          {it.starred ? (
                            <span role="img" aria-label={t("drive.starred")}>
                              <StarIcon className="text-signal size-3.5 shrink-0 fill-current" />
                            </span>
                          ) : null}
                          {it.visibility === "workspace" || it.sharedWith.length || it.editors.length ? (
                            <span role="img" aria-label={t("drive.isShared")}>
                              <UsersIcon className="text-ink-2 size-3.5 shrink-0" />
                            </span>
                          ) : null}
                        </button>
                      </td>
                      <td className="text-ink-2 hidden px-3 py-2.5 md:table-cell">
                        <PersonTrigger userId={it.ownerId} className="flex items-center gap-1.5 rounded-md hover:underline">
                          <Avatar id={it.ownerId} size="xs" />
                          {it.ownerId === dir.me ? t("drive.me") : dir.name(it.ownerId)}
                        </PersonTrigger>
                      </td>
                      <td className="text-ink-2 hidden px-3 py-2.5 sm:table-cell">{ago(it.updatedAt)}</td>
                      <td className="text-ink-2 px-3 py-2.5 text-right text-xs tabular-nums">{it.kind === "file" ? size(it.size) : "—"}</td>
                      <td className="px-1 py-1">
                        <Menu
                          label={t("drive.actions", { name: it.name })}
                          items={actions(it)}
                          trigger={
                            <span className="text-ink-2 hover:bg-hover grid size-7 place-items-center rounded-md">
                              <MoreIcon className="size-4" />
                            </span>
                          }
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        {naming ? (
          <NameModal
            title={naming.item ? t("drive.rename") : t("drive.newFolder")}
            initial={naming.item?.name ?? ""}
            onClose={() => setNaming(null)}
            onSave={(name) =>
              void act(() =>
                naming.item
                  ? api(`work/drive/items/${naming.item.id}`, { method: "PATCH", body: { name } })
                  : api("work/drive/folders", { method: "POST", body: { name, parentId } }),
              ).then(() => setNaming(null))
            }
          />
        ) : null}
        {sharing ? (
          <ShareModal
            item={sharing}
            onClose={() => setSharing(null)}
            onSaved={() => {
              setSharing(null);
              router.refresh();
            }}
          />
        ) : null}
        {moving ? (
          <MoveModal
            item={moving}
            onClose={() => setMoving(null)}
            onMoved={() => {
              setMoving(null);
              router.refresh();
            }}
          />
        ) : null}
        {preview ? (
          <Modal title={preview.name} onClose={() => setPreview(null)} wide>
            <div className="grid gap-3">
              {kindOf(preview) === "image" ? (
                <img src={`/files/${preview.fileId}`} alt={preview.name} className="max-h-[70vh] w-full rounded-md object-contain" />
              ) : kindOf(preview) === "video" ? (
                <video src={`/files/${preview.fileId}`} controls className="max-h-[70vh] w-full rounded-md" />
              ) : null}
              <a href={`/files/${preview.fileId}`} className={cx(btn, "justify-self-start no-underline")}>
                <DownloadIcon className="size-4" />
                {t("drive.download")}
              </a>
            </div>
          </Modal>
        ) : null}
      </div>
    </>
  );
}

function NameModal({ title, initial, onClose, onSave }: { title: string; initial: string; onClose: () => void; onSave: (name: string) => void }) {
  const t = useT();
  const [name, setName] = useState(initial);
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={btn} onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="button" className={btnPrimary} disabled={!name.trim()} onClick={() => onSave(name.trim())}>
            {t("common.save")}
          </button>
        </>
      }
    >
      <Field label={t("drive.name")}>
        <input className={input} value={name} onChange={(e) => setName(e.target.value)} autoFocus onKeyDown={(e) => e.key === "Enter" && name.trim() && onSave(name.trim())} />
      </Field>
    </Modal>
  );
}

function ShareModal({ item, onClose, onSaved }: { item: DriveItem; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const [everyone, setEveryone] = useState(item.visibility === "workspace");
  const [viewers, setViewers] = useState(item.sharedWith);
  const [editors, setEditors] = useState(item.editors);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    try {
      await api(`work/drive/items/${item.id}/sharing`, { method: "PUT", body: { visibility: everyone ? "workspace" : "private", viewers, editors } });
      onSaved();
    } catch {
      setError(t("drive.failed"));
    }
  };
  return (
    <Modal
      title={t("drive.shareTitle", { name: item.name })}
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className={btn} onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="button" className={btnPrimary} onClick={() => void save()}>
            {t("common.save")}
          </button>
        </>
      }
    >
      <div className="grid gap-4">
        <Checkbox checked={everyone} onChange={(e) => setEveryone(e.target.checked)} label={t("drive.everyone")} hint={t("drive.everyoneHint")} />
        <Field label={t("drive.viewers")} error={error}>
          <PeoplePicker selected={viewers} onChange={setViewers} exclude={[item.ownerId]} />
        </Field>
        <Field label={t("drive.editors")} hint={t("drive.editorsHint")}>
          <PeoplePicker selected={editors} onChange={setEditors} exclude={[item.ownerId]} />
        </Field>
      </div>
    </Modal>
  );
}

function MoveModal({ item, onClose, onMoved }: { item: DriveItem; onClose: () => void; onMoved: () => void }) {
  const t = useT();
  const [at, setAt] = useState<{ id: string | null; path: { id: string; name: string }[] }>({ id: null, path: [] });
  const [folders, setFolders] = useState<DriveItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = async (id: string | null) => {
    try {
      const r = await api<DriveData>(`work/drive${id ? `?folder=${id}` : ""}`);
      setFolders(r.items.filter((x) => x.kind === "folder" && x.id !== item.id));
      setAt({ id, path: r.path });
      setError(null);
    } catch {
      setError(t("drive.failed"));
    }
  };
  useEffect(() => {
    void load(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const move = async () => {
    try {
      await api(`work/drive/items/${item.id}`, { method: "PATCH", body: { parentId: at.id } });
      onMoved();
    } catch {
      setError(t("drive.moveFailed"));
    }
  };
  return (
    <Modal
      title={t("drive.moveTitle", { name: item.name })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={btn} onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="button" className={btnPrimary} onClick={() => void move()}>
            {t("drive.moveHere")}
          </button>
        </>
      }
    >
      <div className="grid gap-2">
        <p className="m-0 flex flex-wrap gap-1 text-sm font-medium">
          <button type="button" className="text-brand-text underline" onClick={() => void load(null)}>
            {t("drive.mine")}
          </button>
          {at.path.map((p) => (
            <span key={p.id}>
              ›{" "}
              <button type="button" className="text-brand-text underline" onClick={() => void load(p.id)}>
                {p.name}
              </button>
            </span>
          ))}
        </p>
        <ul className="border-hairline m-0 grid max-h-64 list-none overflow-y-auto rounded-md border p-1">
          {(folders ?? []).map((f) => (
            <li key={f.id}>
              <button type="button" className="hover:bg-hover flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm" onClick={() => void load(f.id)}>
                <FolderIcon className="text-ink-2 size-4" />
                {f.name}
              </button>
            </li>
          ))}
          {folders && folders.length === 0 ? <li className="text-ink-2 px-2 py-1.5 text-sm">{t("drive.noFolders")}</li> : null}
        </ul>
        {error ? (
          <p role="alert" className="text-block m-0 text-sm">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
