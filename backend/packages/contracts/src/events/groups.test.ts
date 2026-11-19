import { describe, expect, it } from "vitest";
import { CONSUMER_GROUPS, isConsumerGroup } from "./groups.js";
import { EVENTS, topicOf, type EventType } from "./registry.js";

describe("consumer groups", () => {
  const produced = new Set(Object.keys(EVENTS).map((t) => topicOf(t as EventType)));

  it("read only topics some registered event travels on", () => {
    for (const [group, topics] of Object.entries(CONSUMER_GROUPS)) for (const t of topics) expect(produced.has(t), `${group} reads ${t}`).toBe(true);
  });

  it("list each topic once per group", () => {
    for (const topics of Object.values(CONSUMER_GROUPS)) expect(new Set(topics).size).toBe(topics.length);
  });

  it("recognise a listed group", () => {
    expect(isConsumerGroup("home-projector")).toBe(true);
    expect(isConsumerGroup("nobody")).toBe(false);
  });
});
