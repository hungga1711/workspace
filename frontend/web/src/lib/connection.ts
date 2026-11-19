"use client";

import { useSyncExternalStore } from "react";

/**
 * What the app knows about its link to the server: the browser's own online flag, the realtime socket, and whether
 * the session was refused. The shell's banner reads it, and send buttons stay disabled while it is not "ok".
 */
export type Connection = "ok" | "offline" | "lost" | "expired";

let realtimeDown = false;
let expired = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function current(): Connection {
  if (expired) return "expired";
  if (typeof navigator !== "undefined" && navigator.onLine === false) return "offline";
  return realtimeDown ? "lost" : "ok";
}

export const connection = {
  realtime(up: boolean) {
    if (realtimeDown === !up) return;
    realtimeDown = !up;
    emit();
  },
  sessionExpired() {
    if (expired) return;
    expired = true;
    emit();
  },
};

function subscribe(l: () => void) {
  listeners.add(l);
  window.addEventListener("online", l);
  window.addEventListener("offline", l);
  return () => {
    listeners.delete(l);
    window.removeEventListener("online", l);
    window.removeEventListener("offline", l);
  };
}

/** "ok" on the server render: the banner and disabled buttons only ever appear after hydration. */
export const useConnection = () => useSyncExternalStore(subscribe, current, () => "ok" as Connection);
/** Whether a send/save button should be usable right now. */
export const useCanSend = () => {
  const c = useConnection();
  return c === "ok" || c === "lost";
};
