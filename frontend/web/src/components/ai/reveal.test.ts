import { describe, expect, it } from "vitest";
import { closeOpenMarks, graphemeEnd, nextShown, splitBlocks } from "./reveal";

/** Frames of 16 ms until everything is shown: how many it took, and the largest step. */
function play(target: string, from = 0) {
  let shown = from;
  let carry = 0;
  let frames = 0;
  let step = 0;
  while (shown < target.length && frames < 10_000) {
    const r = nextShown(target, shown, 16, carry);
    step = Math.max(step, r.shown - shown);
    ({ shown, carry } = r);
    frames++;
  }
  return { frames, step, shown };
}

describe("nextShown", () => {
  it("reveals a short backlog a character or two a frame, not in one jump", () => {
    const r = play("Xin chào, tôi có thể giúp gì?");
    expect(r.shown).toBe("Xin chào, tôi có thể giúp gì?".length);
    expect(r.step).toBeLessThanOrEqual(2);
    expect(r.frames).toBeGreaterThan(10);
  });

  it("speeds up when a lot is waiting: a backlog shrinks by more than half in under half a second", () => {
    const target = "a".repeat(2000);
    let shown = 0;
    let carry = 0;
    for (let f = 0; f < 25; f++) ({ shown, carry } = nextShown(target, shown, 16, carry));
    expect(target.length - shown).toBeLessThan(1000);
    expect(play(target).frames * 16).toBeLessThan(3_000);
  });

  it("keeps a fraction of a character for the next frame", () => {
    const first = nextShown("abcdef", 0, 8);
    expect(first.shown).toBe(0);
    expect(first.carry).toBeGreaterThan(0);
    expect(nextShown("abcdef", 0, 8, first.carry).shown).toBe(0 + Math.floor(first.carry * 2));
  });

  it("never splits a letter from its marks (Vietnamese written with combining tones)", () => {
    const nfd = "Tiến độ".normalize("NFD");
    let shown = 0;
    let carry = 0;
    while (shown < nfd.length) {
      ({ shown, carry } = nextShown(nfd, shown, 16, carry));
      expect(/^\p{M}/u.test(nfd.slice(shown))).toBe(false);
    }
  });

  it("never goes past what arrived, and a long pause between frames is not a jump", () => {
    expect(nextShown("abc", 3, 16)).toEqual({ shown: 3, carry: 0 });
    expect(nextShown("x".repeat(30), 0, 5_000).shown).toBeLessThan(30);
  });
});

describe("graphemeEnd", () => {
  it("moves past combining marks and emoji halves", () => {
    expect(graphemeEnd("éx", 1)).toBe(2);
    expect(graphemeEnd("😀!", 1)).toBe(2);
    expect(graphemeEnd("ab", 1)).toBe(1);
  });
});

describe("closeOpenMarks", () => {
  it("closes bold and code spans being typed, holds back a lone star", () => {
    expect(closeOpenMarks("This is **impor")).toBe("This is **impor**");
    expect(closeOpenMarks("Run `npm i")).toBe("Run `npm i`");
    expect(closeOpenMarks("A list *")).toBe("A list ");
    expect(closeOpenMarks("Done **bold** here")).toBe("Done **bold** here");
  });
  it("leaves a code block alone", () => {
    expect(closeOpenMarks("```js\nconst a = `x")).toBe("```js\nconst a = `x");
  });
});

describe("splitBlocks", () => {
  it("cuts at blank lines, keeping code blocks and loose lists whole", () => {
    const text = "Intro line.\n\n1. One\n\n2. Two\n\n```\na\n\nb\n```\n\nEnd.";
    expect(splitBlocks(text)).toEqual(["Intro line.", "1. One\n\n2. Two", "```\na\n\nb\n```", "End."]);
  });
  it("joined again, gives back the same text", () => {
    const text = "# Title\n\nPara one\nstill one.\n\n- a\n- b\n\nLast";
    expect(splitBlocks(text).join("\n\n")).toBe(text);
  });
});
