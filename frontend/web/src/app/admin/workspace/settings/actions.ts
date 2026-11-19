"use server";

import { revalidateTag } from "next/cache";
import { SETUP_TAG } from "@/lib/setup";
import { readSession } from "@/lib/session";

/**
 * After the workspace settings are saved: drop the cached `/api/setup` answer (language, time zone), which is
 * otherwise kept a minute, so the next page anyone opens is already in the new language and zone.
 */
export async function refreshWorkspaceSetup() {
  // Server actions are public endpoints: only a signed-in person may drop the server's caches.
  if (!(await readSession())) return;
  revalidateTag(SETUP_TAG);
}
