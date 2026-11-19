import "reflect-metadata";
import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NestMiddleware,
  UnauthorizedException,
} from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { runWithRequestId, runWithContext, MissingRequestContextError, type Principal, authorize, type Resource } from "@workspace/shared";
import { PRINCIPAL_HEADER, verifyInternalToken } from "./internal-token.js";
import { logger } from "./logger.js";
import { REQUEST_ID_HEADER, requestIdFrom } from "./request-id.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      principal?: Principal;
      requestId?: string;
      /** The user's sign-in session, when the gateway forwarded one. */
      sessionId?: string;
    }
  }
}

/**
 * Verifies the gateway-signed principal and binds the request context (actor, request id) for the whole request; requests without a valid
 * principal never reach a handler. Every request gets a request id (the signed one, else a well-formed
 * x-request-id header, else a new one), echoed in the response header.
 */
export function principalMiddleware(secret: string, publicPaths: string[] = ["/health"]) {
  @Injectable()
  class PrincipalMiddleware implements NestMiddleware {
    async use(req: Request, res: Response, next: NextFunction) {
      const path = (req.originalUrl ?? req.url).split("?")[0] ?? "";
      const fallbackId = requestIdFrom(req.header(REQUEST_ID_HEADER));
      const token = publicPaths.includes(path) ? undefined : req.header(PRINCIPAL_HEADER);
      if (!token) {
        req.requestId = fallbackId;
        res.setHeader(REQUEST_ID_HEADER, fallbackId);
        if (publicPaths.includes(path)) return runWithRequestId(fallbackId, () => next());
        return res.status(401).json({ error: "unauthenticated", requestId: fallbackId });
      }
      let verified: Awaited<ReturnType<typeof verifyInternalToken>>;
      try {
        verified = await verifyInternalToken(token, secret);
      } catch {
        res.setHeader(REQUEST_ID_HEADER, fallbackId);
        return res.status(401).json({ error: "invalid principal token", requestId: fallbackId });
      }
      const { principal, requestId, sessionId, origin } = verified;
      const actorId = `${principal.type}:${principal.id}`;
      req.principal = principal;
      req.requestId = requestId;
      if (sessionId) req.sessionId = sessionId;
      res.setHeader(REQUEST_ID_HEADER, requestId);
      runWithContext({ actorId, requestId, origin }, () => next());
    }
  }
  return PrincipalMiddleware;
}

export function requirePrincipal(req: Request): Principal {
  if (!req.principal) throw new UnauthorizedException();
  return req.principal;
}

/** What `parse` needs of a schema (zod's `safeParse`), so this package does not depend on zod. */
interface BodySchema<T> {
  safeParse(input: unknown): { success: true; data: T } | { success: false; error: { issues: { path: (string | number)[]; message: string }[] } };
}

/** Validates a request body or query at the controller edge: 400 naming each failing field (`path: message`). */
export function parse<T>(schema: BodySchema<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new BadRequestException(r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  return r.data;
}

/** Keyset cursor for directory lists sorted by name: the last row's (name, user id), opaque to clients. */
export const encodeNameCursor = (name: string, userId: string) => Buffer.from(JSON.stringify([name, userId])).toString("base64url");

export function decodeNameCursor(s: string): { name: string; userId: string } {
  try {
    const [name, userId] = JSON.parse(Buffer.from(s, "base64url").toString()) as [string, string];
    if (typeof name !== "string" || typeof userId !== "string") throw new Error();
    return { name, userId };
  } catch {
    throw new BadRequestException("bad cursor");
  }
}

/** Throws 403 unless the principal may perform permission on resource. */
export function assertAllowed(principal: Principal, permission: string, resource: Resource = {}): void {
  const d = authorize(principal, permission, resource);
  if (!d.allowed) throw new ForbiddenException(d.reason);
}

@Catch()
export class ErrorFilter implements ExceptionFilter {
  catch(err: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    // Every error body names the request id, so a user report leads straight to the logs.
    const requestId = http.getRequest<Request>().requestId;
    const send = (status: number, body: object) => res.status(status).json({ ...body, ...(requestId ? { requestId } : {}) });
    if (err instanceof HttpException) {
      const body = err.getResponse();
      return send(err.getStatus(), typeof body === "string" ? { error: body } : body);
    }
    if (err instanceof MissingRequestContextError) {
      return send(HttpStatus.UNAUTHORIZED, { error: "no request context" });
    }
    // body-parser errors (too large, malformed JSON) carry their HTTP status and are the client's fault.
    const parser = err as { type?: string; status?: number; expose?: boolean };
    if (parser.expose && parser.status && parser.status >= 400 && parser.status < 500) {
      return send(parser.status, {
        error: parser.type === "entity.too.large" ? "request body too large" : parser.type === "entity.parse.failed" ? "malformed JSON" : "bad request",
      });
    }
    const pgCode = (err as { code?: string }).code;
    // insufficient_privilege: a module role reached past its own schema (ADR-0023).
    if (pgCode === "42501") return send(HttpStatus.FORBIDDEN, { error: "permission denied" });
    if (pgCode === "23505") return send(HttpStatus.CONFLICT, { error: "conflict" });
    logger.error({ err }, "unhandled error");
    return send(HttpStatus.INTERNAL_SERVER_ERROR, { error: "internal error" });
  }
}
