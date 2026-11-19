"use client";

import { api } from "@/lib/client";

const KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;

/** Push works only with a server key, notifications and a service worker in this browser. */
export const pushSupported = () => !!KEY && typeof Notification !== "undefined" && typeof navigator !== "undefined" && "serviceWorker" in navigator;

/** Whether this browser already has a subscription for this app. */
export async function deviceSubscribed(): Promise<boolean> {
  if (!pushSupported() || Notification.permission !== "granted") return false;
  const reg = await navigator.serviceWorker.getRegistration("/sw.js");
  return !!(await reg?.pushManager.getSubscription());
}

/** Asks the browser (only after the person chose to), subscribes, and registers the device. */
export async function subscribeDevice(): Promise<"ok" | "denied" | "unsupported"> {
  if (!pushSupported()) return "unsupported";
  if ((await Notification.requestPermission()) !== "granted") return "denied";
  const reg = await navigator.serviceWorker.register("/sw.js");
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: KEY });
  const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  await api("home/push/subscriptions", { method: "POST", body: { endpoint: json.endpoint, keys: json.keys } });
  return "ok";
}

/** Removes this browser's subscription here and on the server. */
export async function unsubscribeDevice(): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration("/sw.js");
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await api("home/push/subscriptions", { method: "DELETE", body: { endpoint: sub.endpoint } }).catch(() => undefined);
  await sub.unsubscribe();
}
