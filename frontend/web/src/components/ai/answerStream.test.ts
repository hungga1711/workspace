import { describe, expect, it } from "vitest";
import { SseParser } from "./answerStream";

describe("SseParser", () => {
  it("splits events cut anywhere, skips keep-alive comments", () => {
    const p = new SseParser();
    expect(p.push('event: start\ndata: {"id":"s1"}\n\nevent: del')).toEqual([{ event: "start", data: '{"id":"s1"}' }]);
    expect(p.push('ta\ndata: {"t":"Xin "}\n\n: ping\n\n')).toEqual([{ event: "delta", data: '{"t":"Xin "}' }]);
    expect(p.push('event: done\r\ndata: {"answer":"Xin chào"}\r\n\r\n')).toEqual([{ event: "done", data: '{"answer":"Xin chào"}' }]);
  });

  it("an event without a name is a message", () => {
    expect(new SseParser().push("data: x\n\n")).toEqual([{ event: "message", data: "x" }]);
  });
});
