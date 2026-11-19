"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { api } from "@/lib/client";
import { useT } from "@/lib/i18n/client";
import { Avatar, useDirectory } from "@/lib/people";
import { btn, btnPrimary, cx, input } from "@/lib/ui";
import { Modal } from "@/components/ui/Modal";
import { Field } from "@/components/ui/bits";
import { CheckIcon, HashIcon, LockIcon } from "@/components/app/icons";

/** People picker used by new channel, DM, approvals and sharing. */
export function PeoplePicker({ selected, onChange, single, exclude = [] }: { selected: string[]; onChange: (ids: string[]) => void; single?: boolean; exclude?: string[] }) {
  const dir = useDirectory();
  const t = useT();
  const [q, setQ] = useState("");
  const list = useMemo(
    () =>
      // The directory can hold someone twice (its first page plus a search that found them again): one row each.
      [...new Map(dir.people.map((p) => [p.userId, p])).values()].filter(
        (p) => !exclude.includes(p.userId) && p.status !== "disabled" && (p.displayName + " " + (p.email ?? "")).toLowerCase().includes(q.toLowerCase()),
      ),
    [dir.people, q, exclude],
  );
  const toggle = (id: string) => onChange(single ? [id] : selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  return (
    <div className="grid grid-cols-1 gap-2">
      <input className={input} placeholder={t("chat.newChat.searchPeople")} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t("chat.newChat.findPerson")} />
      <ul className="border-hairline m-0 max-h-60 list-none overflow-auto rounded-md border p-1" role="listbox" aria-multiselectable={!single}>
        {list.map((p) => {
          const on = selected.includes(p.userId);
          return (
            <li key={p.userId} role="option" aria-selected={on}>
              <button
                type="button"
                onClick={() => toggle(p.userId)}
                className={cx("hover:bg-hover flex w-full items-center gap-2.5 rounded-sm px-2 py-1.5 text-left", on && "bg-brand-wash")}
              >
                <Avatar id={p.userId} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{p.displayName}</span>
                  {p.email ? <span className="text-ink-2 block truncate text-xs">{p.email}</span> : null}
                </span>
                {on ? <CheckIcon className="text-brand-text size-4" /> : null}
              </button>
            </li>
          );
        })}
        {list.length === 0 ? <li className="text-ink-2 px-2 py-3 text-center text-sm">{t("chat.newChat.noOne")}</li> : null}
      </ul>
    </div>
  );
}

export function NewChannelModal({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const dir = useDirectory();
  const t = useT();
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [kind, setKind] = useState<"public" | "private">("public");
  const KindIcon = kind === "private" ? LockIcon : HashIcon;
  const [members, setMembers] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const slug = name
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const submit = async () => {
    if (!slug) {
      setError(t("chat.newChat.nameRequired"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ id: string }>("chat/channels", { method: "POST", body: { kind, name: slug, displayName: name.trim(), topic, memberIds: members } });
      onClose();
      router.push(`/app/chat/${r.id}`);
      router.refresh();
    } catch (e) {
      const status = (e as { status?: number }).status;
      setError(t(status === 409 ? "chat.newChat.nameTaken" : status === 403 ? "chat.newChat.noPermission" : "chat.newChat.createFailed"));
      setBusy(false);
    }
  };
  return (
    <Modal
      title={t("chat.newChat.createChannel")}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={btn} onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="button" className={btnPrimary} disabled={busy} onClick={() => void submit()}>
            {t(busy ? "chat.newChat.creating" : "chat.newChat.createChannel")}
          </button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4">
        <Field label={t("chat.newChat.channelName")} hint={slug ? t("chat.newChat.willShowAs", { slug }) : t("chat.newChat.nameHint")} error={error}>
          {/* The channel's mark as it will show in the sidebar: # for public, a lock once "private" is picked. */}
          <span className="relative block">
            <KindIcon aria-hidden="true" className="text-ink-2 pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2" />
            <input className={cx(input, "pl-9")} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("chat.newChat.namePlaceholder")} autoFocus />
          </span>
        </Field>
        <Field label={t("chat.newChat.topicOptional")}>
          <input className={input} value={topic} onChange={(e) => setTopic(e.target.value)} placeholder={t("chat.newChat.topicPlaceholder")} />
        </Field>
        <fieldset className="grid grid-cols-1 gap-2">
          <legend className="mb-1.5 text-sm font-medium">{t("chat.newChat.visibility")}</legend>
          {(
            [
              ["public", t("chat.newChat.public"), t("chat.newChat.publicHint")],
              ["private", t("chat.newChat.private"), t("chat.newChat.privateHint")],
            ] as const
          ).map(([v, l, d]) => (
            <label key={v} className={cx("flex cursor-pointer gap-2.5 rounded-md border px-3 py-2.5", kind === v ? "border-brand-text bg-brand-wash" : "border-hairline")}>
              <input type="radio" name="kind" checked={kind === v} onChange={() => setKind(v)} className="mt-0.5" />
              <span>
                <span className="block font-medium">{l}</span>
                <span className="text-ink-2 text-sm">{d}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <Field label={t("chat.newChat.addMembers")}>
          <PeoplePicker selected={members} onChange={setMembers} exclude={[dir.me]} />
        </Field>
      </div>
    </Modal>
  );
}

/** "Sofia, Clara, Pablo", cut to the 80 characters a conversation name may have. */
const groupName = (names: string[]) => {
  const all = names.filter(Boolean).join(", ");
  return all.length > 80 ? `${all.slice(0, 79)}…` : all;
};

export function NewDmModal({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const dir = useDirectory();
  const t = useT();
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const open = async (ids: string[]) => {
    setError(null);
    try {
      // One person: a direct message. Several: a private group conversation.
      const r =
        ids.length === 1
          ? await api<{ id: string }>("chat/dms", { method: "POST", body: { userId: ids[0] } })
          : await api<{ id: string }>("chat/channels", {
              method: "POST",
              // A group chat, listed with the DMs and named after everyone in it (first names, as people say them).
              body: { kind: "group", displayName: groupName([dir.me, ...ids].map((i) => dir.short(i).split(" ")[0] ?? "")), memberIds: ids },
            });
      onClose();
      router.push(`/app/chat/${r.id}`);
      router.refresh();
    } catch {
      setError(t("chat.newChat.openFailed"));
    }
  };
  return (
    <Modal
      title={t("chat.newChat.newMessage")}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={btn} onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="button" className={btnPrimary} disabled={picked.length === 0} onClick={() => void open(picked)}>
            {t(picked.length > 1 ? "chat.newChat.createGroup" : "chat.newChat.message")}
          </button>
        </>
      }
    >
      <p className="text-ink-2 mb-3 text-sm">{t("chat.newChat.intro")}</p>
      {error ? (
        <p className="text-block mb-2 text-sm" role="alert">
          {error}
        </p>
      ) : null}
      <PeoplePicker selected={picked} onChange={setPicked} exclude={[dir.me]} />
    </Modal>
  );
}
