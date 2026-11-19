"use client";

// Before the canvas chunk is evaluated: the editor builds its font URLs from this path when its module loads.
import "./assetPath";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import { useAiEnabled } from "@/lib/ai-context";
import { useT } from "@/lib/i18n/client";
import { projectHref, whiteboardHref } from "@/lib/links";
import { AvatarStack } from "@/lib/people";
import { btn, btnDanger, btnGhost, btnPrimary, btnSm, chip, cx, iconBtn, input, mono, tag } from "@/lib/ui";
import { ScreenCrumb } from "@/components/shell/ScreenTitle";
import { Menu } from "@/components/ui/Menu";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { SparkleIcon, DownloadIcon, FolderIcon, GridIcon, HelpIcon, MoreIcon, PencilIcon, ShareIcon, TrashIcon, ArrowRightIcon } from "@/components/app/icons";
import { whiteboardsHref } from "./folders";
import type { BoardController, Presence, SaveState, SelectedSticky } from "./controller";
import { STICKY_COLORS, type StickyColor } from "./palette";
import type { WbFolders, WbLink, Whiteboard, WhiteboardSummary } from "./types";

// The canvas (the drawing editor, ~1 MB) and live editing load after the header paints, in the browser only.
const Canvas = dynamic(() => import("./Canvas").then((m) => m.Canvas), { ssr: false, loading: () => <CanvasLoading /> });
// Dialogs and the AI panel load when opened.
const StickyTaskDialog = dynamic(() => import("./panels").then((m) => m.StickyTaskDialog), { ssr: false });
const AccessDialog = dynamic(() => import("./panels").then((m) => m.AccessDialog), { ssr: false });
const MoveDialog = dynamic(() => import("./panels").then((m) => m.MoveDialog), { ssr: false });
const InsertTemplateDialog = dynamic(() => import("./panels").then((m) => m.InsertTemplateDialog), { ssr: false });
const AiPanel = dynamic(() => import("./panels").then((m) => m.AiPanel), { ssr: false });

function CanvasLoading() {
  const t = useT();
  return (
    <div className="bg-surface absolute inset-0 grid place-items-center" role="status">
      <span className="text-ink-2 animate-pulse text-sm">{t("whiteboard.loading")}</span>
    </div>
  );
}

/**
 * A whiteboard: a compact header (code, project, who is here, save state, Share, Export, AI, more) over a full-height
 * canvas. View-only people get the canvas in view mode. Selecting stickies offers their colours and "Create tasks".
 */
export function WhiteboardEditor({ board: initial }: { board: Whiteboard }) {
  const t = useT();
  const router = useRouter();
  const toast = useToast();
  const aiOn = useAiEnabled();
  const [board, setBoard] = useState<WhiteboardSummary>(initial);
  const [links, setLinks] = useState<WbLink[]>(initial.links);
  const ctl = useRef<BoardController | null>(null);
  const [ready, setReady] = useState(false);
  const [selected, setSelected] = useState<SelectedSticky[]>([]);
  const [peers, setPeers] = useState<Presence[]>([]);
  const [online, setOnline] = useState(true);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [dialog, setDialog] = useState<null | "tasks" | "share" | "templates" | "rename" | "delete" | "keys" | "move">(null);
  const [projects, setProjects] = useState<{ id: string; name: string }[]>(initial.projectId && initial.projectName ? [{ id: initial.projectId, name: initial.projectName }] : []);
  const [folders, setFolders] = useState<WbFolders | null>(null);
  const folder = initial.path.at(-1) ?? null;
  const [aiOpen, setAiOpen] = useState(false);
  const canEdit = board.canEdit;

  const onReady = useCallback((c: BoardController) => {
    ctl.current = c;
    setReady(true);
  }, []);
  // The badges follow the latest links (a new task, or someone else's).
  useEffect(() => {
    if (ready) ctl.current?.setLinks(links);
  }, [ready, links]);
  const refreshLinks = useCallback(() => {
    void api<{ links: WbLink[] }>(`work/whiteboards/${board.id}/links`)
      .then((r) => setLinks(r.links))
      .catch(() => undefined);
  }, [board.id]);

  useEffect(() => {
    if (dialog !== "share" || !board.canManage) return;
    void api<{ projects: { id: string; name: string }[] }>("work/projects")
      .then((r) => setProjects(r.projects))
      .catch(() => undefined);
  }, [dialog, board.canManage]);

  const exportAs = (kind: "png" | "svg") => void ctl.current?.exportImage(kind).catch(() => toast({ message: t("whiteboard.exportFailed") }));
  const saveLabel = saveState === "saving" ? t("whiteboard.saving") : saveState === "saved" ? t("whiteboard.saved") : saveState === "error" ? t("whiteboard.saveFailed") : null;
  const ids = [...new Set(peers.map((p) => p.id))];
  const editable = selected.filter((s) => !s.linked && s.text.trim());

  const more = [
    ...(board.canManage ? [{ label: t("common.edit"), icon: <PencilIcon />, onSelect: () => setDialog("rename") }] : []),
    ...(board.canManage
      ? [
          {
            label: t("whiteboard.folder.moveTo"),
            icon: <ArrowRightIcon />,
            onSelect: () => {
              setDialog("move");
              void api<WbFolders>("work/whiteboards/folders")
                .then(setFolders)
                .catch(() => {
                  setDialog(null);
                  toast({ message: t("whiteboard.folder.moveFailed") });
                });
            },
          },
        ]
      : []),
    ...(canEdit ? [{ label: t("whiteboard.templates"), icon: <GridIcon />, onSelect: () => setDialog("templates") }] : []),
    { label: t("whiteboard.shortcuts"), icon: <HelpIcon />, onSelect: () => setDialog("keys") },
    ...(board.canManage ? [{ label: t("whiteboard.delete"), icon: <TrashIcon />, danger: true, onSelect: () => setDialog("delete") }] : []),
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScreenCrumb label={board.title} />
      <h1 className="sr-only">{board.title}</h1>
      <div className="border-divider flex min-h-[52px] shrink-0 items-center gap-2 border-b px-3 md:px-4">
        <div className="flex min-w-0 flex-1 items-center gap-2 text-xs max-md:text-[13px]">
          <Link
            href={whiteboardsHref({ folder: folder?.id })}
            className="text-ink-2 hover:text-ink flex min-w-0 shrink items-center gap-1 no-underline max-sm:hidden"
            title={initial.path.map((f) => f.name).join(" / ") || t("whiteboard.folder.all")}
          >
            <FolderIcon className="size-3.5 shrink-0" />
            <span className="max-w-40 truncate">{folder?.name ?? t("whiteboard.folder.all")}</span>
          </Link>
          <span className={cx(mono, "text-ink-2 shrink-0")}>{board.code}</span>
          {board.projectId && board.projectName ? (
            <Link href={projectHref({ id: board.projectId })} className={cx(tag, "min-w-0 truncate no-underline max-sm:hidden")} title={board.projectName}>
              {board.projectName}
            </Link>
          ) : null}
          {!canEdit ? <span className={chip}>{t("whiteboard.viewOnly")}</span> : null}
          {!online ? (
            <span className="text-warn truncate" role="status">
              {t("whiteboard.offline")}
            </span>
          ) : saveLabel ? (
            <span className={cx("truncate max-sm:hidden", saveState === "error" ? "text-block" : "text-ink-2")} role="status" aria-live="polite">
              {saveLabel}
            </span>
          ) : null}
        </div>
        {ids.length ? (
          <span className="flex shrink-0 items-center gap-1.5" title={peers.map((p) => p.name).join(", ")}>
            <span className="sr-only">{t("whiteboard.peers", { count: ids.length })}</span>
            <AvatarStack ids={ids} max={4} />
          </span>
        ) : null}
        <div className="flex shrink-0 items-center gap-1">
          {aiOn ? (
            <button type="button" className={cx(btnGhost, btnSm, "max-sm:px-2")} aria-pressed={aiOpen} aria-label={t("whiteboard.aiTitle")} onClick={() => setAiOpen((v) => !v)}>
              <SparkleIcon />
              <span className="max-sm:hidden">{t("whiteboard.ai")}</span>
            </button>
          ) : null}
          <Menu
            label={t("whiteboard.export")}
            trigger={
              <span className={cx(btnGhost, btnSm, "max-sm:px-2")}>
                <DownloadIcon />
                <span className="max-sm:hidden">{t("whiteboard.export")}</span>
              </span>
            }
            items={[
              { label: t("whiteboard.exportPng"), onSelect: () => exportAs("png") },
              { label: t("whiteboard.exportSvg"), onSelect: () => exportAs("svg") },
            ]}
          />
          <button type="button" className={cx(btn, btnSm, "max-sm:px-2")} aria-label={t("whiteboard.share")} onClick={() => setDialog("share")}>
            <ShareIcon />
            <span className="max-sm:hidden">{t("whiteboard.share")}</span>
          </button>
          <Menu
            label={t("whiteboard.more")}
            trigger={
              <span className={iconBtn}>
                <MoreIcon />
              </span>
            }
            items={more}
          />
        </div>
      </div>

      <div className="relative min-h-0 flex-1" data-whiteboard={board.id}>
        <Canvas
          board={initial}
          canEdit={canEdit}
          onReady={onReady}
          onSelection={setSelected}
          onPeers={setPeers}
          onConnection={setOnline}
          onSaveState={setSaveState}
          onLinksChanged={refreshLinks}
          onSaved={(updatedAt) => setBoard((b) => ({ ...b, updatedAt }))}
        />
        {canEdit && selected.length ? (
          <div
            role="toolbar"
            aria-label={t("whiteboard.tools")}
            className="bg-surface shadow-popover border-hairline absolute bottom-20 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-lg border p-1 max-md:bottom-auto max-md:top-16"
          >
            <span className="sr-only">{t("whiteboard.stickyColor")}</span>
            {STICKY_COLORS.map((c) => (
              <button
                key={c.key}
                type="button"
                aria-label={t(`whiteboard.color.${c.key}`)}
                title={t(`whiteboard.color.${c.key}`)}
                onClick={() => ctl.current?.recolor(c.key as StickyColor)}
                className="border-edge hover:ring-ink-2 grid size-8 place-items-center rounded-md border transition-shadow hover:ring-1"
              >
                {/* The sticky's own colour (scene data, palette.ts). */}
                <span className="block size-5 rounded-full" style={{ backgroundColor: c.color }} />
              </button>
            ))}
            <button type="button" className={cx(btn, btnSm, "ml-1")} disabled={!editable.length} onClick={() => setDialog("tasks")}>
              {t("whiteboard.createTasks")}
            </button>
          </div>
        ) : null}
        {aiOn && aiOpen ? <AiPanel boardId={board.id} controller={ctl} onClose={() => setAiOpen(false)} canEdit={canEdit} /> : null}
      </div>

      {dialog === "tasks" ? (
        <StickyTaskDialog
          boardId={board.id}
          projectId={board.projectId}
          stickies={selected}
          onClose={() => setDialog(null)}
          onCreated={(created) => {
            setSelected((sel) => sel.map((s) => (created.some((c) => c.elementId === s.id) ? { ...s, linked: true } : s)));
            setLinks((l) => [...l.filter((x) => !created.some((c) => c.elementId === x.elementId)), ...created]);
            toast({ message: t("whiteboard.tasksDone", { count: created.length }) });
          }}
        />
      ) : null}
      {dialog === "share" ? (
        <AccessDialog
          target={{ type: "board", id: board.id, name: board.title }}
          parentName={folder?.name ?? null}
          link={whiteboardHref(board)}
          project={board.canManage ? { projectId: board.projectId, projects } : undefined}
          onClose={() => setDialog(null)}
          onSaved={(s) => {
            setBoard((x) => ({ ...x, ...s }));
            router.refresh();
          }}
        />
      ) : null}
      {dialog === "move" && folders ? (
        <MoveDialog
          item={{ type: "board", id: board.id, name: board.title, folderId: board.folderId }}
          folders={folders.folders}
          canTop={folders.canCreate}
          onClose={() => setDialog(null)}
          onDone={(folderId) => {
            setBoard((x) => ({ ...x, folderId }));
            router.refresh();
          }}
        />
      ) : null}
      {dialog === "templates" ? (
        <InsertTemplateDialog onClose={() => setDialog(null)} onInsert={(key) => void ctl.current?.insertTemplate(key).catch(() => toast({ message: t("common.actionFailed") }))} />
      ) : null}
      {dialog === "rename" ? <RenameDialog board={board} onClose={() => setDialog(null)} onRenamed={(title) => setBoard((b) => ({ ...b, title }))} /> : null}
      {dialog === "keys" ? <ShortcutsDialog onClose={() => setDialog(null)} /> : null}
      {dialog === "delete" ? (
        <Modal
          title={t("whiteboard.deleteTitle")}
          onClose={() => setDialog(null)}
          footer={
            <>
              <button type="button" className={btn} onClick={() => setDialog(null)}>
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className={btnDanger}
                onClick={() =>
                  void api(`work/whiteboards/${board.id}`, { method: "DELETE" })
                    .then(() => router.push(whiteboardsHref({ folder: board.folderId })))
                    .catch(() => toast({ message: t("whiteboard.deleteFailed") }))
                }
              >
                {t("common.delete")}
              </button>
            </>
          }
        >
          <p className="m-0 text-sm">{t("whiteboard.deleteBody", { title: board.title })}</p>
        </Modal>
      ) : null}
    </div>
  );
}

function RenameDialog({ board, onClose, onRenamed }: { board: WhiteboardSummary; onClose: () => void; onRenamed: (title: string) => void }) {
  const t = useT();
  const toast = useToast();
  const [title, setTitle] = useState(board.title);
  const save = async () => {
    const next = title.trim();
    if (!next || next === board.title) return onClose();
    try {
      await api(`work/whiteboards/${board.id}`, { method: "PATCH", body: { title: next } });
      onRenamed(next);
      onClose();
    } catch {
      toast({ message: t("common.actionFailed") });
    }
  };
  return (
    <Modal
      title={t("whiteboard.titleLabel")}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={btn} onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" form="wb-rename" className={btnPrimary}>
            {t("common.save")}
          </button>
        </>
      }
    >
      <form
        id="wb-rename"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <input aria-label={t("whiteboard.titleLabel")} className={input} value={title} maxLength={200} autoFocus onChange={(e) => setTitle(e.target.value)} />
      </form>
    </Modal>
  );
}

/** Our own keys first (the sticky), then the canvas's full list behind its "?" button. */
function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const rows: [string, string][] = [
    ["S", t("whiteboard.keySticky")],
    ["Enter", t("whiteboard.keyType")],
    ["Delete", t("whiteboard.keyDelete")],
    ["Space", t("whiteboard.keyPan")],
    ["Ctrl + / −", t("whiteboard.keyZoom")],
    ["Ctrl + Z", t("whiteboard.keyUndo")],
    ["?", t("whiteboard.keyAll")],
  ];
  return (
    <Modal title={t("whiteboard.shortcutsTitle")} onClose={onClose}>
      <dl className="m-0 grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-sm">
        {rows.map(([k, label]) => (
          <div key={k} className="contents">
            <dt>
              <kbd className="border-hairline bg-hover rounded-sm border px-1.5 py-0.5 font-mono text-[11px]">{k}</kbd>
            </dt>
            <dd className="m-0">{label}</dd>
          </div>
        ))}
      </dl>
    </Modal>
  );
}
