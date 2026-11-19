/**
 * Fixed-window counter per key, in this web process's memory (one web process serves the installation). For
 * endpoints anyone can call, so a client cannot flood the logs; a restart only resets the windows early.
 */
export function rateLimiter(limit: number, windowMs: number) {
  const windows = new Map<string, { n: number; until: number }>();
  return (key: string): boolean => {
    const now = Date.now();
    const w = windows.get(key);
    if (!w || w.until <= now) {
      // Bounded: windows that ended are dropped once the map grows.
      if (windows.size > 10_000) for (const [k, v] of windows) if (v.until <= now) windows.delete(k);
      windows.set(key, { n: 1, until: now + windowMs });
      return true;
    }
    return ++w.n <= limit;
  };
}
