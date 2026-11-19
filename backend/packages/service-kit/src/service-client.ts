import { newId, type Grant, type Principal, currentRequestId } from "@workspace/shared";
import { serviceFetch } from "./in-process.js";
import { PRINCIPAL_HEADER, signInternalToken } from "./internal-token.js";

export class ServiceCallError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    message: string,
  ) {
    super(message);
    this.name = "ServiceCallError";
  }
}

/**
 * Module-to-module client. Calls carry either a PLATFORM service principal (internal endpoints) or the end user's
 * principal forwarded as-is, so the called module re-authorizes against the same identity. A module hosted by this
 * process is called in memory (`serviceFetch`), with the same token.
 */
export class ServiceClient {
  constructor(
    private readonly baseUrl: string,
    private readonly secret: string,
    private readonly serviceName: string,
    private readonly serviceGrants: Grant[],
    /** Model-backed endpoints (the ai module) need longer than the 10 s default. */
    private readonly opts: { timeoutMs?: number } = {},
  ) {}

  servicePrincipal(): Principal {
    return { type: "service", id: this.serviceName, teamIds: [], departmentId: null, grants: this.serviceGrants };
  }

  /** Calls keep the caller's request id. */
  async request<T>(method: string, path: string, body?: unknown, as?: Principal, requestId = currentRequestId() ?? newId()): Promise<T> {
    const token = await signInternalToken({ principal: as ?? this.servicePrincipal(), requestId }, this.secret);
    const res = await serviceFetch(`${this.baseUrl}${path}`, {
      method,
      headers: { [PRINCIPAL_HEADER]: token, "content-type": "application/json", "x-request-id": requestId },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
    });
    const text = await res.text();
    const parsed: unknown = text ? JSON.parse(text) : null;
    if (!res.ok) throw new ServiceCallError(res.status, parsed, `${method} ${path} → ${res.status}`);
    return parsed as T;
  }
}
