/**
 * Short-lived state the server keeps in memory (ADR 0021): caches (principals, session state, workspace state),
 * rate-limit windows, presence, calls ringing. One process hosts every module, so a Map shared by the modules is
 * enough, and since Node runs one thing at a time, read-then-write is atomic as long as nothing awaits in between.
 * Nothing here survives a restart: what must (sessions, drafts) lives in Postgres.
 *
 * Values are strings (callers own the encoding). Expired keys are dropped when read, and a sweep every minute drops
 * the ones nobody reads again.
 */
interface Entry {
  value: string;
  /** Epoch ms; Infinity for no expiry. */
  until: number;
}

export interface SetOptions {
  /** Expires after this long. Without it (and without keepTtl) the key never expires. */
  ttlMs?: number;
  /** Only when the key does not exist; returns false otherwise. */
  nx?: boolean;
  /** Keeps the current expiry of an existing key. */
  keepTtl?: boolean;
}

export class MemoryKv {
  private readonly map = new Map<string, Entry>();
  private readonly sweeper: ReturnType<typeof setInterval>;

  constructor(sweepMs = 60_000) {
    this.sweeper = setInterval(() => this.sweep(), sweepMs);
    this.sweeper.unref();
  }

  private live(key: string, now = Date.now()): Entry | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.until <= now) {
      this.map.delete(key);
      return undefined;
    }
    return e;
  }

  get(key: string): string | null {
    return this.live(key)?.value ?? null;
  }

  mget(keys: string[]): (string | null)[] {
    return keys.map((k) => this.get(k));
  }

  /** Returns whether the value was written (false only with `nx` on an existing key). */
  set(key: string, value: string, opts: SetOptions = {}): boolean {
    const now = Date.now();
    const cur = this.live(key, now);
    if (opts.nx && cur) return false;
    const until = opts.keepTtl && cur ? cur.until : opts.ttlMs !== undefined ? now + opts.ttlMs : Infinity;
    this.map.set(key, { value, until });
    return true;
  }

  /** Deletes keys; returns how many existed. */
  del(...keys: string[]): number {
    let n = 0;
    for (const k of keys) if (this.live(k) && this.map.delete(k)) n++;
    return n;
  }

  /** Deletes every key starting with prefix (a workspace's cached principals, …). */
  delPrefix(prefix: string): number {
    let n = 0;
    for (const k of this.map.keys())
      if (k.startsWith(prefix)) {
        this.map.delete(k);
        n++;
      }
    return n;
  }

  /**
   * Adds 1 and returns the new count. A key created here expires after windowMs (a fixed window: later increments
   * keep the expiry); without windowMs it keeps any expiry it has.
   */
  incr(key: string, windowMs?: number): number {
    const now = Date.now();
    const cur = this.live(key, now);
    const n = (cur ? Number(cur.value) || 0 : 0) + 1;
    this.map.set(key, { value: String(n), until: cur ? cur.until : windowMs !== undefined ? now + windowMs : Infinity });
    return n;
  }

  /** How long a key still lives, in ms: 0 when it does not exist, Infinity when it never expires. */
  ttl(key: string): number {
    const now = Date.now();
    const cur = this.live(key, now);
    return cur ? cur.until - now : 0;
  }

  /** Sets a new expiry on an existing key; returns false when it does not exist. */
  expire(key: string, ttlMs: number): boolean {
    const cur = this.live(key);
    if (!cur) return false;
    cur.until = Date.now() + ttlMs;
    return true;
  }

  /** Forgets everything (tests). */
  clear(): void {
    this.map.clear();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [k, e] of this.map) if (e.until <= now) this.map.delete(k);
  }
}

const g = globalThis as unknown as { __workspaceKv?: MemoryKv };

/** The process-wide store every module shares (the gateway reads the session state identity writes). */
export function kv(): MemoryKv {
  return (g.__workspaceKv ??= new MemoryKv());
}
