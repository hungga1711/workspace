"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import { useT } from "@/lib/i18n/client";
import { Avatar, useDirectory } from "@/lib/people";
import { isDnd, useStatus } from "@/lib/status";
import { btn, btnPrimary, btnSm, cx } from "@/lib/ui";
import { Portal } from "@/components/ui/Portal";
import { ChatIcon, MoonIcon } from "@/components/app/icons";
import { CallButtons } from "@/components/call/CallButtons";

interface Profile {
  title: string | null;
  department: string | null;
  managerId: string | null;
}

/**
 * Who wrote this message: a card beside the avatar or name that was clicked (a sheet on phones) with the public
 * profile fields from the directory, their status and whether they are online, and the ways to reach them. Loaded on demand from Conversation.
 */
export function PersonCard({
  userId,
  anchor,
  onClose,
  onHover,
}: {
  userId: string;
  anchor: DOMRect;
  onClose: () => void;
  /** Opened by hovering the trigger: the pointer entering (true) or leaving (false) the card keeps it open or lets it close. */
  onHover?: (inside: boolean) => void;
}) {
  const t = useT();
  const dir = useDirectory();
  const router = useRouter();
  const status = useStatus().get(userId);
  const [profile, setProfile] = useState<Profile | null | "none">(null);
  // Whether they are here right now; null until known (or when the read fails: then the row is left out).
  const [online, setOnline] = useState<boolean | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const person = dir.byId.get(userId);
  const self = userId === dir.me;

  useEffect(() => {
    let live = true;
    // Members without an employee record (just invited, a bot account) still get the card, without the job fields.
    api<Profile>(`employee/employees/${encodeURIComponent(userId)}`)
      .then((p) => live && setProfile(p))
      .catch(() => live && setProfile("none"));
    void api<{ presence: Record<string, boolean> | { userId: string; online: boolean }[] }>(`chat/presence?userIds=${encodeURIComponent(userId)}`)
      .then((r) => live && setOnline(Array.isArray(r.presence) ? !!r.presence.find((x) => x.userId === userId)?.online : !!r.presence[userId]))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [userId]);

  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key);
    };
  }, [onClose]);

  // Beside the trigger, kept 8px inside the viewport; re-measured once the profile fills the card in.
  const place = useCallback(() => {
    const el = ref.current;
    if (!el || window.matchMedia("(max-width: 639px)").matches) return;
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = anchor.right + 8 + w <= vw - 8 ? anchor.right + 8 : Math.max(8, Math.min(anchor.left, vw - 8 - w));
    const top = Math.max(8, Math.min(anchor.top, vh - 8 - h));
    Object.assign(el.style, { left: `${Math.round(left)}px`, top: `${Math.round(top)}px` });
  }, [anchor]);
  useEffect(place, [place, profile]);

  const message = async () => {
    const r = await api<{ id: string }>("chat/dms", { method: "POST", body: { userId } });
    onClose();
    router.push(`/app/chat/${r.id}`);
  };

  const p = profile && profile !== "none" ? profile : null;
  const job = [p?.title, p?.department].filter(Boolean).join(" · ");
  const dnd = isDnd(status);
  const statusText = [status?.emoji, status?.text].filter(Boolean).join(" ");

  return (
    <Portal>
      <div
        ref={ref}
        role="dialog"
        aria-label={dir.name(userId)}
        onPointerEnter={(e) => e.pointerType === "mouse" && onHover?.(true)}
        onPointerLeave={(e) => e.pointerType === "mouse" && onHover?.(false)}
        className={cx("bg-surface shadow-popover border-hairline fixed z-[80] rounded-xl border p-4", "sm:w-88 max-sm:inset-x-3 max-sm:bottom-3")}
      >
        <div className="flex items-start gap-3">
          <Avatar id={userId} size="xl" />
          <div className="min-w-0 flex-1 pt-1">
            <p className="m-0 truncate font-semibold">{dir.name(userId)}</p>
            {person?.nickname ? <p className="text-ink-2 m-0 truncate text-xs">{t("chat.person.nickname", { name: person.nickname })}</p> : null}
            {profile === null ? (
              <span className="bg-hover mt-1.5 block h-3.5 w-32 animate-pulse rounded-sm" />
            ) : job ? (
              <p className="text-ink-2 m-0 mt-0.5 text-sm">{job}</p>
            ) : null}
            {person?.email ? <p className="text-ink-2 m-0 mt-0.5 truncate text-xs">{person.email}</p> : null}
          </div>
        </div>
        {statusText || dnd ? (
          <p className="bg-hover m-0 mt-3 flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm">
            {statusText ? <span className="min-w-0 truncate">{statusText}</span> : null}
            {dnd ? (
              <span className="text-ink-2 ml-auto inline-flex shrink-0 items-center gap-1 text-xs">
                <MoonIcon className="size-3.5" aria-hidden="true" />
                {t("status.dnd")}
              </span>
            ) : null}
          </p>
        ) : null}
        {/* Status instead of the work location (most people work in one place, so it says nothing). */}
        {p?.managerId || online !== null ? (
          <dl className="m-0 mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
            {online !== null ? (
              <>
                <dt className="text-ink-2">{t("chat.person.status")}</dt>
                <dd className="m-0 flex min-w-0 items-center gap-1.5">
                  <span aria-hidden="true" className={cx("size-2 shrink-0 rounded-full", online ? "bg-ok" : "bg-ink-2/40")} />
                  <span className="truncate">{t(online ? "chat.person.online" : "chat.person.away")}</span>
                </dd>
              </>
            ) : null}
            {p?.managerId ? (
              <>
                <dt className="text-ink-2">{t("chat.person.manager")}</dt>
                <dd className="m-0 truncate">{dir.name(p.managerId)}</dd>
              </>
            ) : null}
          </dl>
        ) : null}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {self ? (
            <Link href="/app/me" className={cx(btn, btnSm)} onClick={onClose}>
              {t("chat.person.myProfile")}
            </Link>
          ) : (
            <>
              <button type="button" className={cx(btnPrimary, btnSm)} onClick={() => void message()}>
                <ChatIcon className="size-4" />
                {t("chat.person.message")}
              </button>
              <CallButtons userId={userId} />
              <Link href={`/app/me/people?u=${encodeURIComponent(userId)}`} className={cx(btn, btnSm, "ml-auto")} onClick={onClose}>
                {t("chat.person.directory")}
              </Link>
            </>
          )}
        </div>
      </div>
    </Portal>
  );
}
