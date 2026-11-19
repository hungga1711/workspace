"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";
import { useT } from "@/lib/i18n/client";
import { whiteboardHref } from "@/lib/links";
import { btn, btnPrimary, input } from "@/lib/ui";
import { Modal } from "@/components/ui/Modal";
import { Picker } from "@/components/ui/Picker";
import { Segmented } from "@/components/ui/Segmented";
import { TemplateGrid } from "./TemplateCards";

export { TemplateCards } from "./TemplateCards";
import type { TemplateKey, Whiteboard } from "./types";

/**
 * "Bảng trắng mới": name, template, project and who reaches it: the open folder's people (or, at the top level, the
 * whole company) or only its creator; finer sharing is the Share dialog's. The server seeds the scene from the
 * template (in the reader's language) and the new board opens.
 */
export function NewWhiteboardDialog({
  onClose,
  projects,
  initialTemplate = "blank",
  initialProject,
  folder = null,
}: {
  onClose: () => void;
  projects: { id: string; name: string }[];
  initialTemplate?: TemplateKey;
  initialProject?: string;
  /** The folder it is made in (null: the top level). */
  folder?: { id: string; name: string } | null;
}) {
  const t = useT();
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [template, setTemplate] = useState<TemplateKey>(initialTemplate);
  const [projectId, setProjectId] = useState(initialProject ?? "");
  const [access, setAccess] = useState<"shared" | "private">("shared");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const b = await api<Whiteboard>("work/whiteboards", {
        method: "POST",
        body: {
          // Without a name the server names the board after its template, in the reader's language.
          ...(title.trim() ? { title: title.trim() } : {}),
          template,
          ...(projectId ? { projectId } : {}),
          ...(folder ? { folderId: folder.id } : {}),
          ...(access === "private" ? { visibility: "private" } : {}),
        },
      });
      router.push(whiteboardHref(b));
    } catch {
      setError(t("whiteboard.createFailed"));
      setBusy(false);
    }
  };
  return (
    <Modal
      wide
      title={t("whiteboard.newTitle")}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={btn} onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="button" className={btnPrimary} disabled={busy} onClick={() => void create()}>
            {t("whiteboard.create")}
          </button>
        </>
      }
    >
      <form
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <label className="grid gap-1.5 text-sm font-medium">
          {t("whiteboard.titleLabel")}
          <input className={input} value={title} maxLength={200} autoFocus placeholder={t(`whiteboard.template.${template}`)} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <div className="grid gap-1.5">
          <span className="text-sm font-medium">{t("whiteboard.templateLabel")}</span>
          <TemplateGrid value={template} onChange={setTemplate} label={t("whiteboard.templateLabel")} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <span className="text-sm font-medium">{t("whiteboard.projectLabel")}</span>
            <Picker
              variant="field"
              label={t("whiteboard.projectLabel")}
              value={projectId}
              onChange={setProjectId}
              options={[{ value: "", label: t("whiteboard.noProject") }, ...projects.map((p) => ({ value: p.id, label: p.name }))]}
            />
          </div>
          <div className="grid content-start gap-1.5">
            <span className="text-sm font-medium">{t("whiteboard.visibilityLabel")}</span>
            <Segmented
              className="w-full [&>button]:min-w-0 [&>button]:flex-1"
              label={t("whiteboard.visibilityLabel")}
              value={access}
              onChange={setAccess}
              options={[
                { value: "shared", label: folder ? t("whiteboard.newAccess.folder") : t("whiteboard.vis.workspace") },
                { value: "private", label: t("whiteboard.vis.private") },
              ]}
            />
            <span className="text-ink-2 text-xs">
              {access === "private"
                ? t("whiteboard.visHint.private")
                : folder
                  ? t("whiteboard.newAccess.folderHint", { name: folder.name })
                  : projectId
                    ? t("whiteboard.visHint.project")
                    : t("whiteboard.visHint.workspace")}
            </span>
          </div>
        </div>
        {error ? (
          <p role="alert" className="text-block m-0 text-sm">
            {error}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}
