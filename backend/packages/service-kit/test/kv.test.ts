import { afterEach, describe, expect, it, vi } from "vitest";
import { kv, MemoryKv } from "../src/kv.js";

afterEach(() => vi.useRealTimers());

describe("MemoryKv", () => {
  it("expires keys, honours nx and keepTtl", () => {
    vi.useFakeTimers();
    const s = new MemoryKv();
    expect(s.set("a", "1", { ttlMs: 1000 })).toBe(true);
    expect(s.set("a", "2", { ttlMs: 1000, nx: true })).toBe(false);
    expect(s.get("a")).toBe("1");
    vi.advanceTimersByTime(600);
    s.set("a", "3", { keepTtl: true });
    vi.advanceTimersByTime(500);
    expect(s.get("a")).toBeNull();
    expect(s.set("a", "4", { nx: true })).toBe(true);
    vi.advanceTimersByTime(86_400_000);
    expect(s.get("a")).toBe("4");
  });

  it("counts in a fixed window", () => {
    vi.useFakeTimers();
    const s = new MemoryKv();
    expect(s.incr("rl", 1000)).toBe(1);
    vi.advanceTimersByTime(900);
    expect(s.incr("rl", 1000)).toBe(2);
    vi.advanceTimersByTime(200);
    expect(s.incr("rl", 1000)).toBe(1);
  });

  it("deletes by key and by prefix, reads many", () => {
    const s = new MemoryKv();
    s.set("principal:t1:a", "x");
    s.set("principal:t1:b", "y");
    s.set("principal:t2:a", "z");
    expect(s.mget(["principal:t1:a", "nope"])).toEqual(["x", null]);
    expect(s.delPrefix("principal:t1:")).toBe(2);
    expect(s.del("principal:t2:a", "nope")).toBe(1);
    expect(s.get("principal:t2:a")).toBeNull();
  });

  it("is one store per process", () => {
    expect(kv()).toBe(kv());
  });
});
