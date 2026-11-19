import "server-only";
import { notFound, unstable_rethrow } from "next/navigation";
import { GatewayError } from "./gateway";

/** A page's main read: the data, or the status that kept it from loading (never thrown to the error screen). */
export type PageRead<T> = { data: T; failed?: undefined } | { data?: undefined; failed: number };

/**
 * Reads the record a page is about. Only a real 404 becomes the not-found page; a 403 and any other failure
 * (a busy server's 429, a restart's 503) come back as `failed`, so the page shows "no access" or a retry in place of
 * its body while the shell keeps working. Redirects (sign-in, 2FA setup) still happen.
 */
export async function readPage<T>(p: Promise<T>): Promise<PageRead<T>> {
  try {
    return { data: await p };
  } catch (e) {
    unstable_rethrow(e);
    if (e instanceof GatewayError) {
      if (e.status === 404) notFound();
      return { failed: e.status };
    }
    return { failed: 500 };
  }
}
