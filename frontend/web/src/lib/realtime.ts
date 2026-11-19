"use client";

import type { Socket } from "socket.io-client";
import { api } from "@/lib/client";
import { connection } from "@/lib/connection";

const REALTIME_URL = process.env.NEXT_PUBLIC_CHAT_URL ?? "http://localhost:4000";

/**
 * The app's one realtime connection (the server's Socket.IO), shared by every screen that listens:
 * calls ringing anywhere in the app, and chat. socket.io-client is loaded on first use, not with the
 * page. Each (re)connect fetches a fresh 60 s ticket from the gateway.
 */
let socket: Promise<Socket> | null = null;
let users = 0;
let closeTimer: ReturnType<typeof setTimeout> | undefined;

export function connectRealtime(): Promise<Socket> {
  users++;
  clearTimeout(closeTimer);
  socket ??= import("socket.io-client").then(({ io }) => {
    const s = io(REALTIME_URL, {
      transports: ["websocket"],
      reconnectionDelayMax: 10_000,
      auth: (cb) => {
        api<{ ticket: string }>("realtime/ticket", { method: "POST" })
          .then((t) => cb({ ticket: t.ticket }))
          .catch(() => cb({}));
      },
    });
    // Presence ("online" dots) stays fresh while the app is open.
    const hb = setInterval(() => s.connected && s.emit("heartbeat"), 30_000);
    s.on("disconnect", (why) => why === "io client disconnect" && clearInterval(hb));
    // A dropped socket shows the "reconnecting" banner only after a few seconds, so a blip or a deploy restart that
    // reconnects at once never flashes it; closing on purpose (no screen listening) is not a loss.
    let lostTimer: ReturnType<typeof setTimeout> | undefined;
    s.on("disconnect", (why) => {
      if (why === "io client disconnect") return;
      clearTimeout(lostTimer);
      lostTimer = setTimeout(() => !s.connected && connection.realtime(false), 4000);
    });
    s.on("connect", () => {
      clearTimeout(lostTimer);
      connection.realtime(true);
    });
    return s;
  });
  return socket;
}

/** Done with it; the connection closes when nobody has used it for a few seconds (a page change keeps it). */
export function releaseRealtime() {
  users = Math.max(0, users - 1);
  if (users > 0 || !socket) return;
  const s = socket;
  closeTimer = setTimeout(() => {
    if (users > 0) return;
    socket = null;
    void s.then((x) => x.disconnect());
  }, 5000);
}
