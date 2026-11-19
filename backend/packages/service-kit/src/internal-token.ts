import { SignJWT, jwtVerify } from "jose";
import { cleanOrigin, type Grant, type Principal, type RequestOrigin } from "@workspace/shared";

/**
 * The gateway verifies the user's access token (identity's Ed25519 JWT), resolves membership and grants once, then
 * forwards a short-lived signed principal to the modules. Modules trust only this token, never client-supplied
 * actor ids. `sessionId` names the sign-in it came from, for the few account endpoints that act on "this device"
 * (2FA set-up, sessions list).
 */
export interface InternalClaims {
  principal: Principal;
  requestId: string;
  sessionId?: string | undefined;
  /** The caller's address, browser and credential kind, for the audit trail (ADR 0025). */
  origin?: RequestOrigin | undefined;
}

const ISSUER = "workspace-gateway";
const AUDIENCE = "workspace-services";

const key = (secret: string) => new TextEncoder().encode(secret);

export async function signInternalToken(claims: InternalClaims, secret: string, ttlSeconds = 60): Promise<string> {
  return new SignJWT({
    principal: claims.principal,
    rid: claims.requestId,
    ...(claims.sessionId ? { sid: claims.sessionId } : {}),
    ...(claims.origin ? { org: cleanOrigin(claims.origin) } : {}),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(claims.principal.id)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(key(secret));
}

export async function verifyInternalToken(token: string, secret: string): Promise<InternalClaims> {
  const { payload } = await jwtVerify(token, key(secret), { issuer: ISSUER, audience: AUDIENCE });
  const p = payload as { principal?: Principal; rid?: string; sid?: unknown; org?: unknown };
  if (!p.principal || typeof p.rid !== "string") throw new Error("malformed internal token");
  const principal = p.principal;
  if (!Array.isArray(principal.grants) || typeof principal.id !== "string") {
    throw new Error("malformed principal");
  }
  const origin = p.org && typeof p.org === "object" ? cleanOrigin(p.org as RequestOrigin) : undefined;
  return { principal: { ...principal, grants: principal.grants as Grant[] }, requestId: p.rid, sessionId: typeof p.sid === "string" ? p.sid : undefined, origin };
}

export const PRINCIPAL_HEADER = "x-workspace-principal";
