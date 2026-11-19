import { appendToOutbox, authorize, getRequestContext, newId, type Principal } from "@workspace/shared";
import type { PoolClient } from "pg";
import { z } from "zod";
import type { EventPayloadInput, EventType } from "@workspace/contracts";

export const POOL = Symbol("POOL");

export async function emit<T extends EventType>(c: PoolClient, eventType: T, aggregateType: string, aggregateId: string, payload: EventPayloadInput<T>) {
  const { actorId } = getRequestContext();
  await appendToOutbox(c, { eventId: newId(), eventType, version: 1, aggregateType, aggregateId, actorId, occurredAt: new Date().toISOString(), payload });
}

export const allowed = (p: Principal, perm: string, r: Parameters<typeof authorize>[2] = {}) => authorize(p, perm, r).allowed;
export const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export interface EmployeeRow {
  user_id: string;
  code: string;
  display_name: string;
  title: string;
  department_id: string | null;
  manager_id: string | null;
  job_level: string | null;
  hire_date: string | null;
  location: string;
  phone: string;
  active: boolean;
  version: number;
}
