"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n/client";
import { Avatar, useDirectory } from "@/lib/people";
import { cx } from "@/lib/ui";

const PersonCard = dynamic(() => import("./PersonCard").then((m) => m.PersonCard), { ssr: false });

// Hover intent: a pointer passing over an avatar opens nothing; one that rests on it does. Leaving waits a beat so the
// pointer can cross the gap into the card.
const OPEN_MS = 350;
const CLOSE_MS = 250;

/**
 * A person's avatar or name: hovering (mouse) or clicking opens their profile card (loaded only then). A click pins it
 * open; a hover-opened card closes once the pointer has left both the trigger and the card.
 */
export function PersonTrigger({ userId, className, children }: { userId: string; className?: string; children: React.ReactNode }) {
  const t = useT();
  const dir = useDirectory();
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const pinned = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const close = useCallback(() => {
    pinned.current = false;
    setAnchor(null);
  }, []);
  const later = (fn: () => void, ms: number) => {
    clear();
    timer.current = setTimeout(fn, ms);
  };
  // Leaving the trigger or the card: close unless it was clicked open or the pointer came back.
  const leave = () => !pinned.current && later(() => setAnchor(null), CLOSE_MS);
  const onHover = (inside: boolean) => (inside ? clear() : leave());
  useEffect(() => clear, []);
  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={!!anchor}
        aria-label={t("chat.person.open", { name: dir.name(userId) })}
        // Round by default (an avatar); a caller that sets its own corners (a list row) keeps them.
        className={cx("cursor-pointer text-left", !/\brounded/.test(className ?? "") && "rounded-full", className)}
        // A touch held on the row opens the message sheet; a tap on the author is theirs, not the message's.
        onPointerDown={(e) => e.stopPropagation()}
        // While open, the card's outside-click close must not fire first and let this click open it again.
        onMouseDown={(e) => anchor && e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          clear();
          const r = e.currentTarget.getBoundingClientRect();
          // A click on a hover-opened card pins it; a click on a pinned one closes it.
          if (anchor && pinned.current) return close();
          pinned.current = true;
          setAnchor(r);
        }}
        onPointerEnter={(e) => {
          if (e.pointerType !== "mouse") return;
          const r = e.currentTarget.getBoundingClientRect();
          if (anchor) clear();
          else later(() => setAnchor(r), OPEN_MS);
        }}
        onPointerLeave={(e) => e.pointerType === "mouse" && (anchor ? leave() : clear())}
      >
        {children}
      </button>
      {anchor ? <PersonCard userId={userId} anchor={anchor} onClose={close} onHover={onHover} /> : null}
    </>
  );
}

/**
 * A person as the app shows one in a read-only place (a property row, a list line): avatar and name in one trigger
 * that opens their profile card. The one component for that pair, so no screen draws its own avatar + name without
 * the card. Not for a person inside a button, link or picker option (a trigger there would nest a button).
 * Type size and colour come from where it sits (or `className`); `nameClassName` is for a name quieter than its row.
 */
export function PersonChip({
  userId,
  size = "xs",
  dense,
  suffix,
  className,
  nameClassName,
}: {
  userId: string;
  size?: React.ComponentProps<typeof Avatar>["size"];
  /** 6px between avatar and name (meta lines) instead of 8px. */
  dense?: boolean;
  /** After the name, e.g. " (me)" or a role. */
  suffix?: React.ReactNode;
  className?: string;
  nameClassName?: string;
}) {
  const dir = useDirectory();
  return (
    <PersonTrigger
      userId={userId}
      // A caller's own gap or corners replace the defaults (two utilities of one property would race in the stylesheet).
      className={cx(
        "group/person inline-flex min-w-0 max-w-full items-center",
        !/\bgap-/.test(className ?? "") && (dense ? "gap-1.5" : "gap-2"),
        !/\brounded/.test(className ?? "") && "rounded-md",
        className,
      )}
    >
      <Avatar id={userId} size={size} />
      <span className={cx("min-w-0 truncate group-hover/person:underline", nameClassName)}>
        {dir.name(userId)}
        {suffix}
      </span>
    </PersonTrigger>
  );
}
