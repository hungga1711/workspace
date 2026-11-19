"use client";

import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";
import { RichText } from "./RichText";
import { useFormat, useT } from "@/lib/i18n/client";
import { Avatar, useDirectory } from "@/lib/people";
import { btn, btnPrimary, cx, input, skeleton } from "@/lib/ui";
import { Modal } from "@/components/ui/Modal";
import { Checkbox } from "@/components/ui/Checkbox";
import { Field } from "@/components/ui/bits";
import { AttachmentList, type Attachment } from "./attachments";

import { PeoplePicker } from "./NewConversation";
import type { ChannelInfo, Message } from "./Conversation";

/**
 * One GET per channel list (pins, files) with an explicit error state: a failed request shows
 * "Thử lại" instead of loading forever. Shared by the drawers and the docked details panel.
 */
/** Loads a channel list; `refreshKey` changes re-fetch in place (the current items stay visible meanwhile). */
export function useChannelList<T>(path: string, pick: (r: Record<string, unknown>) => T[], refreshKey: string | number = 0) {
  const [state, setState] = useState<{ items: T[] | null; error: boolean }>({ items: null, error: false });
  const [attempt, setAttempt] = useState(0);
  const lastPath = useRef(path);
  useEffect(() => {
    let live = true;
    if (lastPath.current !== path) {
      lastPath.current = path;
      setState({ items: null, error: false });
    }
    api<Record<string, unknown>>(path)
      .then((r) => live && setState({ items: pick(r), error: false }))
      .catch(() => live && setState({ items: null, error: true }));
    return () => {
      live = false;
    };
    // `pick` is a field accessor; re-fetching on its identity would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, attempt, refreshKey]);
  return { ...state, retry: () => setAttempt((n) => n + 1) };
}

export type ChannelFile = Attachment & { ownerId: string; createdAt: string };
export const pinsOf = (r: Record<string, unknown>) => (r.messages ?? []) as Message[];
export const filesOf = (r: Record<string, unknown>) => (r.files ?? []) as ChannelFile[];

export function LoadError({ what, onRetry }: { what: string; onRetry: () => void }) {
  const t = useT();
  return (
    <p className="text-block text-sm" role="alert">
      {t("chat.drawers.loadError", { what })}{" "}
      <button type="button" className="underline" onClick={onRetry}>
        {t("common.retry")}
      </button>
    </p>
  );
}

/** Members with presence, add people, leave: the "Thành viên" tab of the conversation's details. */
export function MembersList({ channel, members, onChange }: { channel: ChannelInfo; members: string[]; onChange: (ids: string[]) => void }) {
  const dir = useDirectory();
  const { t } = useFormat();
  const router = useRouter();
  const [online, setOnline] = useState<Record<string, boolean>>({});
  const [adding, setAdding] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!members.length) return;
    // The endpoint answers for at most 200 ids and a URL of thousands of ULIDs is refused by proxies: ask for the first 200.
    api<{ presence: Record<string, boolean> | { userId: string; online: boolean }[] }>(`chat/presence?userIds=${members.slice(0, 200).join(",")}`)
      .then((r) => setOnline(Array.isArray(r.presence) ? Object.fromEntries(r.presence.map((x) => [x.userId, x.online])) : r.presence))
      .catch(() => undefined);
  }, [members]);
  const add = async () => {
    if (!adding?.length) return;
    try {
      await api(`chat/channels/${channel.id}/members`, { method: "POST", body: { userIds: adding } });
      onChange([...new Set([...members, ...adding])]);
      setAdding(null);
      router.refresh();
    } catch (e) {
      setError(t((e as { status?: number }).status === 403 ? "chat.drawers.onlyAdmins" : "chat.drawers.addFailed"));
    }
  };
  const leave = async () => {
    if (!window.confirm(t("chat.drawers.confirmLeave", { name: channel.name ?? "" }))) return;
    await api(`chat/channels/${channel.id}/members/${dir.me}`, { method: "DELETE" });
    router.push("/app/chat");
    router.refresh();
  };
  return (
    <>
      {adding === null ? (
        <div className="px-4 pt-3">
          <button type="button" className={cx(btn, "w-full")} onClick={() => setAdding([])}>
            {t("chat.drawers.addPeople")}
          </button>
        </div>
      ) : (
        <div className="border-hairline grid gap-3 border-b p-4">
          <PeoplePicker selected={adding} onChange={setAdding} exclude={members} />
          {error ? (
            <p className="text-block text-sm" role="alert">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <button type="button" className={btn} onClick={() => setAdding(null)}>
              {t("common.cancel")}
            </button>
            <button type="button" className={btnPrimary} disabled={!adding.length} onClick={() => void add()}>
              {t("chat.drawers.add", { count: adding.length || "" })}
            </button>
          </div>
        </div>
      )}
      <ul className="m-0 list-none p-2">
        {members.map((id) => (
          <li key={id} className="hover:bg-hover flex items-center gap-3 rounded-lg px-2 py-2">
            <Avatar id={id} size="md" online={online[id] ?? false} />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">
                {dir.name(id)}
                {id === dir.me ? t("chat.drawers.you") : ""}
              </span>
              <span className="text-ink-2 text-xs">{t(online[id] ? "chat.drawers.active" : "chat.drawers.inactive")}</span>
            </span>
          </li>
        ))}
      </ul>
      {channel.kind !== "dm" ? (
        <div className="border-hairline border-t p-4">
          <button type="button" className={cx(btn, "text-block")} onClick={() => void leave()}>
            {t("chat.drawers.leave")}
          </button>
        </div>
      ) : null}
    </>
  );
}

/** Pinned messages, newest first: the "Đã ghim" tab of the conversation's details. */
export function PinsList({ channelId, onOpen, refreshKey }: { channelId: string; onOpen: (id: string) => void; refreshKey?: string | number }) {
  const dir = useDirectory();
  const { t, dayLabel, time } = useFormat();
  const names = dir.names;
  const { items: pins, error, retry } = useChannelList(`chat/channels/${channelId}/pins`, pinsOf, refreshKey);
  return (
    <>
      {error ? (
        <div className="p-4">
          <LoadError what={t("chat.drawers.pinsWhat")} onRetry={retry} />
        </div>
      ) : pins === null ? (
        <div className="grid gap-2 p-4">
          <span className={skeleton} />
          <span className={skeleton} />
        </div>
      ) : pins.length === 0 ? (
        <p className="text-ink-2 p-6 text-center">{t("chat.drawers.noPins")}</p>
      ) : (
        <ul className="divide-hairline m-0 list-none divide-y p-0">
          {pins.map((m) => (
            <li key={m.id}>
              <button type="button" onClick={() => onOpen(m.id)} className="hover:bg-hover grid w-full grid-cols-[32px_minmax(0,1fr)] gap-2.5 px-4 py-3 text-left">
                <Avatar id={m.authorType === "system" ? "system" : m.authorId} size="md" />
                <span className="min-w-0">
                  <span className="flex items-baseline gap-2">
                    <span className="text-sm font-semibold">{dir.name(m.authorType === "system" ? "system" : m.authorId)}</span>
                    <span className="text-ink-2 text-xs tabular-nums">
                      {dayLabel(m.createdAt)} {time(m.createdAt)}
                    </span>
                  </span>
                  <span className="line-clamp-3 text-sm">
                    <RichText text={m.body} names={names} compact />
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** Files shared in the channel, newest first; clicking downloads through a short-lived link. */
export function FilesList({ channelId, refreshKey }: { channelId: string; refreshKey?: string | number }) {
  const dir = useDirectory();
  const { t, ago } = useFormat();
  const { items: files, error, retry } = useChannelList(`chat/channels/${channelId}/files`, filesOf, refreshKey);
  return (
    <div className="p-4">
      {error ? (
        <LoadError what={t("chat.drawers.filesWhat")} onRetry={retry} />
      ) : !files ? (
        <p className="text-ink-2">{t("common.loading")}</p>
      ) : files.length === 0 ? (
        <p className="text-ink-2 text-sm">{t("chat.drawers.noFiles")}</p>
      ) : (
        <ul className="m-0 grid list-none gap-2 p-0">
          {files.map((f) => (
            <li key={f.fileId} className="flex items-center gap-3 text-sm">
              <AttachmentList items={[f]} />
              <span className="text-ink-2 ml-auto shrink-0 text-xs">
                {dir.name(f.ownerId)} · {ago(f.createdAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type Meta = { name: string | null; displayName?: string | null; topic: string; archived: boolean };

/** Channel settings: name, topic, archive. Channel admins and workspace admins only (server-checked). */
export function ChannelSettings({
  channelId,
  isDefault,
  autoJoin,
  meta,
  onClose,
  onSaved,
}: {
  channelId: string;
  isDefault: boolean;
  /** Present for workspace admins on public channels: whether every new member joins it. */
  autoJoin: { on: boolean } | null;
  meta: Meta;
  onClose: () => void;
  onSaved: (m: Meta) => void;
}) {
  const t = useT();
  const [name, setName] = useState(meta.name ?? "");
  const [display, setDisplay] = useState(meta.displayName ?? "");
  const [topic, setTopic] = useState(meta.topic);
  const [auto, setAuto] = useState(autoJoin?.on ?? false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      onSaved(await api<Meta>(`chat/channels/${channelId}`, { method: "PATCH", body }));
    } catch (e) {
      const s = (e as { status?: number }).status;
      setError(t(s === 409 ? "chat.drawers.nameTaken" : s === 400 ? "chat.drawers.nameInvalid" : s === 403 ? "chat.drawers.noPermission" : "chat.drawers.saveFailed"));
      setBusy(false);
    }
  };
  return (
    <Modal
      title={t("chat.drawers.settings")}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={btn} onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className={btnPrimary}
            disabled={busy || !name.trim()}
            onClick={() => void save({ name: name.trim(), displayName: display.trim(), topic, ...(autoJoin && auto !== autoJoin.on ? { autoJoin: auto } : {}) })}
          >
            {t("common.save")}
          </button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4">
        <Field label={t("chat.drawers.displayName")} hint={t("chat.drawers.displayNameHint")}>
          <input className={input} value={display} onChange={(e) => setDisplay(e.target.value)} maxLength={80} placeholder={name} />
        </Field>
        <Field label={t("chat.drawers.name")} error={error} hint={t("chat.drawers.nameHint")}>
          <input className={input} value={name} onChange={(e) => setName(e.target.value.replace(/\s+/g, "-"))} maxLength={80} />
        </Field>
        <Field label={t("chat.drawers.topic")}>
          <input className={input} value={topic} onChange={(e) => setTopic(e.target.value)} maxLength={250} placeholder={t("chat.drawers.topicPlaceholder")} />
        </Field>
        {autoJoin ? <Checkbox checked={auto} onChange={(e) => setAuto(e.target.checked)} label={t("chat.drawers.autoJoin")} hint={t("chat.drawers.autoJoinHint")} /> : null}
        <div className="border-hairline rounded-md border p-3 text-sm">
          <p className="m-0 font-medium">{t("chat.drawers.archiveTitle")}</p>
          {isDefault ? (
            <p className="text-ink-2 m-0 mt-1">{t("chat.drawers.defaultCannotArchive")}</p>
          ) : (
            <>
              <p className="text-ink-2 m-0 mt-1">{t("chat.drawers.archiveHint")}</p>
              <button type="button" className={cx(btn, "border-block text-block mt-2")} disabled={busy} onClick={() => void save({ archived: true })}>
                {t("chat.drawers.archive")}
              </button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
