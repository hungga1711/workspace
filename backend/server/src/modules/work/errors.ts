export class NotFound extends Error {
  override name = "NotFound";
}
export class Forbidden extends Error {
  override name = "Forbidden";
}
export class Invalid extends Error {
  override name = "Invalid";
}
export class Conflict extends Error {
  override name = "Conflict";
  constructor(
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
