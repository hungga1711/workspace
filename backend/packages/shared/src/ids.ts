import { monotonicFactory } from "ulid";

const next = monotonicFactory();

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Internal sortable id. Never use a human-readable code as a primary key. */
export function newId(): string {
  return next();
}

export function isUlid(value: string): boolean {
  return ULID_PATTERN.test(value);
}
