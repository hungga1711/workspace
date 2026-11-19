/** Same rule the gateway applies (contracts REQUEST_ID_PATTERN). */
export const REQUEST_ID_HEADER = "x-request-id";
const PATTERN = /^[\w-]{8,64}$/;

export function requestIdFrom(value: string | null | undefined): string {
  return value && PATTERN.test(value) ? value : crypto.randomUUID();
}
