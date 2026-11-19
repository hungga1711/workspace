"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { useT } from "@/lib/i18n/client";
import { btn, btnGhost, btnPrimary, cx, input, textarea } from "@/lib/ui";
import { Modal } from "@/components/ui/Modal";
import { Field } from "@/components/ui/bits";
import { PeoplePicker } from "@/components/chat/NewConversation";

export interface SpaceDto {
  id: string;
  key: string;
  name: string;
  description: string;
  icon: string;
  visibility: "workspace" | "restricted";
  members?: string[];
  homeId: string | null;
  archived?: boolean;
  canManage?: boolean;
  pages?: number;
}

/** "Kỹ thuật" → "KYTHUAT": a space key proposed from its name. */
export const keyFrom = (name: string) =>
  name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .toUpperCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^A-Z0-9]/g, ""))
    .join("")
    .slice(0, 10);

/** The fields a space is made of; shared by the create and settings dialogs. */
function SpaceFields({
  icon,
  name,
  description,
  restricted,
  members,
  error,
  disabled,
  keyField,
  onChange,
}: {
  icon: string;
  name: string;
  description: string;
  restricted: boolean;
  members: string[];
  error: string | null;
  disabled?: boolean;
  /** The key: editable when creating, fixed afterwards (it is in every page's code). */
  keyField: React.ReactNode;
  onChange: (patch: Partial<{ icon: string; name: string; description: string; restricted: boolean; members: string[] }>) => void;
}) {
  const t = useT();
  return (
    <div className="grid gap-4">
      {/* The icon column is as wide as its label ("Biểu tượng" wrapped in 72px and pushed its field a line below the others). */}
      <div className="grid grid-cols-[minmax(72px,max-content)_minmax(0,1fr)] gap-3 sm:grid-cols-[minmax(72px,max-content)_minmax(0,1fr)_140px]">
        <Field label={t("docs.space.icon")}>
          <input className={cx(input, "text-center text-lg")} size={2} value={icon} maxLength={4} disabled={disabled} onChange={(e) => onChange({ icon: e.target.value })} />
        </Field>
        <Field label={t("docs.space.name")} error={error}>
          <input className={input} value={name} disabled={disabled} onChange={(e) => onChange({ name: e.target.value })} placeholder={t("docs.space.namePlaceholder")} autoFocus />
        </Field>
        {/* Phones: the key gets its own row, so the name is not squeezed to a few letters. */}
        <div className="max-sm:col-span-2">{keyField}</div>
      </div>
      <Field label={t("docs.space.description")}>
        <textarea
          className={cx(textarea, "min-h-16")}
          value={description}
          disabled={disabled}
          onChange={(e) => onChange({ description: e.target.value })}
          placeholder={t("docs.space.descriptionPlaceholder")}
        />
      </Field>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-0.5" checked={restricted} disabled={disabled} onChange={(e) => onChange({ restricted: e.target.checked })} />
        <span>
          <span className="block font-medium">{t("docs.space.restricted")}</span>
          <span className="text-ink-2 block">{t("docs.space.restrictedHint")}</span>
        </span>
      </label>
      {restricted ? (
        <Field label={t("docs.space.members")}>
          <PeoplePicker selected={members} onChange={(m) => onChange({ members: m })} />
        </Field>
      ) : null}
    </div>
  );
}

export function NewSpaceModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const router = useRouter();
  const [f, setF] = useState({ name: "", icon: "📘", description: "", restricted: false, members: [] as string[] });
  const [key, setKey] = useState("");
  const [keyTouched, setKeyTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!keyTouched) setKey(keyFrom(f.name));
  }, [f.name, keyTouched]);
  const create = async () => {
    setError(null);
    try {
      const s = await api<SpaceDto>("work/spaces", {
        method: "POST",
        body: { key, name: f.name, description: f.description, icon: f.icon, visibility: f.restricted ? "restricted" : "workspace", members: f.members },
      });
      router.push(`/app/work/docs/${s.homeId}`);
    } catch (e) {
      const st = (e as { status?: number }).status;
      setError(t(st === 409 ? "docs.space.keyTaken" : st === 400 ? "docs.space.keyInvalid" : "docs.space.failed"));
    }
  };
  return (
    <Modal
      title={t("docs.home.newSpace")}
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className={btn} onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="button" className={btnPrimary} disabled={!f.name.trim() || key.length < 2} onClick={() => void create()}>
            {t("docs.space.create")}
          </button>
        </>
      }
    >
      <SpaceFields
        {...f}
        error={error}
        onChange={(p) => setF((x) => ({ ...x, ...p }))}
        keyField={
          <Field label={t("docs.space.key")} hint={t("docs.space.keyHint")}>
            <input
              className={cx(input, "font-mono uppercase")}
              value={key}
              maxLength={10}
              onChange={(e) => {
                setKeyTouched(true);
                setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""));
              }}
            />
          </Field>
        }
      />
    </Modal>
  );
}

/**
 * Space settings: name, icon, description,
 * who may read it, and archiving. Loads the space itself, so the tree and the cards need only its key.
 */
export function EditSpaceModal({ spaceKey, onClose, onSaved }: { spaceKey: string; onClose: () => void; onSaved?: () => void }) {
  const t = useT();
  const router = useRouter();
  const [space, setSpace] = useState<SpaceDto | null>(null);
  const [f, setF] = useState({ name: "", icon: "", description: "", restricted: false, members: [] as string[] });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  useEffect(() => {
    api<{ space: SpaceDto }>(`work/spaces/${spaceKey}`)
      .then(({ space: s }) => {
        setSpace(s);
        setF({ name: s.name, icon: s.icon, description: s.description, restricted: s.visibility === "restricted", members: s.members ?? [] });
      })
      .catch(() => setError(t("docs.space.saveFailed")));
  }, [spaceKey, t]);
  const patch = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await api(`work/spaces/${spaceKey}`, { method: "PATCH", body });
      onSaved?.();
      router.refresh();
      onClose();
    } catch {
      setError(t("docs.space.saveFailed"));
      setBusy(false);
    }
  };
  const save = () =>
    patch({ name: f.name, description: f.description, icon: f.icon, visibility: f.restricted ? "restricted" : "workspace", members: f.restricted ? f.members : [] });
  return (
    <Modal
      title={t("docs.space.settings")}
      onClose={onClose}
      wide
      footer={
        <>
          {space ? (
            space.archived ? (
              <button type="button" className={cx(btnGhost, "mr-auto")} disabled={busy} onClick={() => void patch({ archived: false })}>
                {t("docs.space.restore")}
              </button>
            ) : confirmArchive ? (
              <span className="mr-auto flex flex-wrap items-center gap-2 text-sm">
                <span className="text-ink-2 max-w-md">{t("docs.space.archiveHint")}</span>
                <button type="button" className={cx(btn, "text-block! hover:bg-block-wash")} disabled={busy} onClick={() => void patch({ archived: true })}>
                  {t("docs.space.archive")}
                </button>
              </span>
            ) : (
              <button type="button" className={cx(btnGhost, "text-block! hover:bg-block-wash mr-auto")} onClick={() => setConfirmArchive(true)}>
                {t("docs.space.archive")}
              </button>
            )
          ) : null}
          <button type="button" className={btn} onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="button" className={btnPrimary} disabled={!space || busy || !f.name.trim()} onClick={() => void save()}>
            {t("docs.space.save")}
          </button>
        </>
      }
    >
      <SpaceFields
        {...f}
        error={error}
        disabled={!space}
        onChange={(p) => setF((x) => ({ ...x, ...p }))}
        keyField={
          <Field label={t("docs.space.key")}>
            <input className={cx(input, "font-mono uppercase")} value={space?.key ?? spaceKey} readOnly />
          </Field>
        }
      />
    </Modal>
  );
}
