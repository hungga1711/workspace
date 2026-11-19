"use client";

import { api } from "@/lib/client";

/** A one-to-one call as the chat module reports it (backend/server/src/modules/chat/calls.ts). */
export interface CallInfo {
  id: string;
  from: string;
  to: string;
  video: boolean;
  code: string;
  channelId: string;
  state: "ringing" | "accepted" | "declined" | "missed" | "cancelled" | "ended";
  startedAt: number;
  acceptedAt: number | null;
}

export const callUrl = (c: { id: string; code: string }) => `/meet/${c.code}?call=${c.id}`;

/**
 * Calls someone: their app rings, and the call screen opens in a new tab for the caller (ringing until
 * they answer). Returns why it could not ring: "busy" (on another call), "dnd" (Do not disturb) or "failed".
 */
export async function startCall(userId: string, video: boolean): Promise<null | "busy" | "dnd" | "failed"> {
  // Opened inside the click, so the browser does not block it; filled in once the call exists.
  const tab = window.open("about:blank", "_blank");
  try {
    const c = await api<CallInfo>("chat/calls", { method: "POST", body: { userId, video } });
    if (tab) tab.location.href = callUrl(c);
    else window.location.href = callUrl(c);
    return null;
  } catch (e) {
    tab?.close();
    const body = (e as { body?: { error?: string } }).body;
    return body?.error === "busy" ? "busy" : body?.error === "dnd" ? "dnd" : "failed";
  }
}
