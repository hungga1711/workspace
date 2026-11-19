"use client";

import { useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import { connectRealtime, releaseRealtime } from "@/lib/realtime";

/**
 * Chat's view of the app's one realtime connection (lib/realtime). `onReconnect` lets the page recover
 * gaps after the connection comes back (the server says "ready" on every connect).
 */
export function useRealtime(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each event has its own payload shape; handlers narrow it
  handlers: Record<string, (data: any) => void>,
  onReconnect: () => void,
) {
  const socketRef = useRef<Socket | null>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const reconnectRef = useRef(onReconnect);
  reconnectRef.current = onReconnect;
  const [status, setStatus] = useState<"connecting" | "online" | "offline">("connecting");

  useEffect(() => {
    let cancelled = false;
    let off = () => undefined as void;
    void connectRealtime().then((socket) => {
      if (cancelled) return;
      socketRef.current = socket;
      // Already connected (another screen opened it): no "ready" is coming for this mount.
      let first = !socket.connected;
      if (socket.connected) {
        setStatus("online");
        // Opened earlier (another screen): pick up conversations made since.
        socket.emit("rooms:sync");
      }
      const ready = () => {
        setStatus("online");
        if (!first) reconnectRef.current();
        first = false;
      };
      const down = () => setStatus("offline");
      const any = (event: string, data: unknown) => handlersRef.current[event]?.(data);
      socket.on("ready", ready);
      socket.on("disconnect", down);
      socket.onAny(any);
      off = () => {
        socket.off("ready", ready);
        socket.off("disconnect", down);
        socket.offAny(any);
      };
    });
    return () => {
      cancelled = true;
      off();
      socketRef.current = null;
      releaseRealtime();
    };
  }, []);

  return { status, emit: (event: string, data: unknown) => socketRef.current?.emit(event, data) };
}
