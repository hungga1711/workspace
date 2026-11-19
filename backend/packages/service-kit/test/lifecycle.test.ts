import { describe, expect, it } from "vitest";
import { drain, onShutdown } from "../src/lifecycle.js";

describe("graceful shutdown", () => {
  it("stops relays, then consumers, then jobs, each phase waiting for its work in hand", async () => {
    const order: string[] = [];
    const slow = (name: string) => async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push(name);
    };
    onShutdown("jobs", slow("job"));
    onShutdown("consumers", slow("consumer"));
    onShutdown("relays", slow("relay"));
    const removed = onShutdown("relays", () => order.push("stopped on its own"));
    removed();
    expect(await drain(1000)).toBe(true);
    expect(order).toEqual(["relay", "consumer", "job"]);
  });

  it("gives up at the deadline", async () => {
    onShutdown("consumers", () => new Promise(() => undefined));
    expect(await drain(30)).toBe(false);
  });
});
