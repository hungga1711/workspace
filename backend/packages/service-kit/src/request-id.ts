import { REQUEST_ID_PATTERN } from "@workspace/contracts";
import { newId, runWithRequestId } from "@workspace/shared";
import { logger } from "./logger.js";

export const REQUEST_ID_HEADER = "x-request-id";

/** Accepts a caller-supplied id only if it is well-formed; otherwise mints one. */
export function requestIdFrom(header: string | undefined | null): string {
  return header && REQUEST_ID_PATTERN.test(header) ? header : newId();
}

/** Runs a background job under its own request id, so its logs and events are correlated too. */
export async function runJob(name: string, fn: () => Promise<unknown>): Promise<void> {
  const requestId = newId();
  try {
    await runWithRequestId(requestId, fn);
  } catch (err) {
    runWithRequestId(requestId, () => logger.error({ err, job: name }, "job failed"));
  }
}
