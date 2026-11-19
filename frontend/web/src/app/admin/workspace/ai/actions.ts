"use server";

import { revalidatePath } from "next/cache";
import { invalidateAiStatus } from "@/lib/ai";
import { readSession } from "@/lib/session";

/** After a connection changes: re-read whether AI is configured, so AI surfaces appear or hide at once. */
export async function refreshAiStatus() {
  // Server actions are public endpoints: only a signed-in person may drop the server's caches.
  if (!(await readSession())) return;
  invalidateAiStatus();
  revalidatePath("/", "layout");
}
