import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { requirePrincipal } from "@workspace/service-kit";
import type { Request } from "express";
import { z } from "zod";
import { isoDateTime, taskPriority, taskStatus } from "@workspace/contracts";
import { Conflict, Forbidden, Invalid, NotFound } from "../errors.js";

export const POOL = Symbol("POOL");
export const STORAGE = Symbol("STORAGE");
export const MEET = Symbol("MEET");
export const EMPLOYEE = Symbol("EMPLOYEE");
export const AI = Symbol("AI");
export const AI_STEPS = Symbol("AI_STEPS");
/** The agent workflow engine's dependencies (workflows.ts Engine). */
export const WORKFLOWS = Symbol("WORKFLOWS");
/** The chat module, asked as the caller for unified search (a task's related documents and messages). */
export const CHAT = Symbol("CHAT");
/** Task sync's dependencies (fetch, the identity lookup of members by email). */
export const TASK_SYNC = Symbol("TASK_SYNC");
/** The integrations hub's dependencies (the fenced request, the preview fetch). */
export const HUB = Symbol("HUB");

export async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof NotFound) throw new NotFoundException(e.message);
    if (e instanceof Forbidden) throw new ForbiddenException(e.message);
    if (e instanceof Invalid) throw new BadRequestException(e.message);
    if (e instanceof Conflict) throw new ConflictException({ error: "conflict", message: e.message, ...e.details });
    throw e;
  }
}

// The task enums are part of the public API (@workspace/contracts), shared with the MCP tools and OpenAPI.
export const statusEnum = taskStatus;
/** The statuses a board column can stand for (cancelled has no column). */
export const columnStatusEnum = z.enum(["todo", "in_progress", "review", "done"]);
export const requestTemplate = z.object({
  name: z.string().trim().min(1).max(80),
  icon: z.string().max(8).default("📝"),
  description: z.string().trim().max(300).default(""),
  fields: z
    .array(z.object({ label: z.string().trim().min(1).max(40), type: z.enum(["text", "textarea", "date", "number"]).default("text") }))
    .min(1)
    .max(10),
  money: z.boolean().default(false),
  approverId: z.string().max(40).nullable().default(null),
});
export const priorityEnum = taskPriority;
export const iso = isoDateTime;
export const guestAccess = z.enum(["open", "lobby", "off"]);

/** Meetings are for people of the workspace (API keys and services have no camera). */
export function member(req: Request) {
  const p = requirePrincipal(req);
  if (p.type !== "user") throw new ForbiddenException("meetings are for workspace members");
  return p;
}
