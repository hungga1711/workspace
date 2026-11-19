"use server";

import { publicGateway } from "@/lib/public-gateway";
import { MEET_CODE } from "@/components/meet/types";
import type { GuestResult } from "@/components/meet/types";

/** Guest side of a meeting link: the gateway's public, per-IP-limited /api/meet routes. */
async function call(path: string, body: unknown): Promise<GuestResult> {
  const res = await publicGateway(path, body);
  const data = (await res.json().catch(() => null)) as (GuestResult & { error?: string }) | null;
  if (res.status === 404) return { status: "not_found" };
  if (res.status === 403) return { status: "members_only" };
  if (res.status === 429) return { status: "error", error: "rate_limited" };
  if (!res.ok || !data) return { status: "error", error: data?.error ?? `HTTP ${res.status}` };
  return data;
}

export async function askToJoin(code: string, name: string): Promise<GuestResult> {
  if (!MEET_CODE.test(code)) return { status: "not_found" };
  return call(`/api/meet/${code}/join`, { name: name.slice(0, 60) });
}

export async function checkRequest(code: string, requestId: string, secret: string): Promise<GuestResult> {
  if (!MEET_CODE.test(code)) return { status: "not_found" };
  return call(`/api/meet/${code}/status`, { requestId, secret });
}
