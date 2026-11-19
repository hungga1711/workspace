/**
 * Pacing for an answer that streams in (Hỏi đáp). Text arrives in bursts at the network's and the model's cadence
 * (measured against Ollama: 5-9 characters every 66 ms, and pauses of seconds), which reads as jerky. The
 * page instead reveals what has arrived at a steady rate, a little each frame, and speeds up when it falls behind, so
 * the words flow evenly and never trail the model by much.
 */

/** Characters a second when little is waiting: about the pace of a fast reader. */
const BASE_RATE = 60;
/** How far behind the received text the reveal may fall: a larger backlog is caught up within about this long. */
const CATCH_UP_S = 0.4;

/** A combining mark (Vietnamese tones written as separate characters) or the second half of a surrogate pair. */
const JOINS = /[\p{M}\uDC00-\uDFFF‍️]/u;

/** `i` moved forward past anything that belongs to the character before it, so no letter is shown without its marks. */
export function graphemeEnd(text: string, i: number): number {
  let j = Math.min(i, text.length);
  while (j < text.length && JOINS.test(text[j]!)) j++;
  return j;
}

/**
 * How much of `target` to show after `dtMs` more milliseconds, from `shown` characters. `carry` holds the fraction of
 * a character owed from earlier frames. Never past what arrived, never inside a character.
 */
export function nextShown(target: string, shown: number, dtMs: number, carry = 0): { shown: number; carry: number } {
  if (shown >= target.length) return { shown: target.length, carry: 0 };
  const backlog = target.length - shown;
  const rate = Math.max(BASE_RATE, backlog / CATCH_UP_S);
  const budget = carry + (rate * Math.min(dtMs, 100)) / 1000;
  const whole = Math.floor(budget);
  if (whole < 1) return { shown, carry: budget };
  const next = graphemeEnd(target, shown + whole);
  return { shown: next, carry: next >= target.length ? 0 : budget - whole };
}

/**
 * Closes Markdown left open at the end of text still being written, so a bold phrase or code span shows as one
 * while it is typed instead of as stray "**" or "`" that turn into formatting a moment later. Only the last line,
 * and never inside a code block.
 */
export function closeOpenMarks(text: string): string {
  const fences = text.match(/^\s*```/gm)?.length ?? 0;
  if (fences % 2) return text;
  const line = text.slice(text.lastIndexOf("\n") + 1);
  const ticks = line.match(/`/g)?.length ?? 0;
  if (ticks % 2) return `${text}\``;
  // A lone "*" or "**" at the very end is not shown yet: it is probably the start of a mark.
  const trimmed = text.replace(/\*{1,2}$/, "");
  const bold = trimmed.slice(trimmed.lastIndexOf("\n") + 1).match(/\*\*/g)?.length ?? 0;
  return bold % 2 ? `${trimmed}**` : trimmed;
}

const LIST_ITEM = /^\s*([-*+]|\d+[.)])\s/;

/**
 * Text cut into Markdown blocks at blank lines, so the blocks already written can be kept as they are and only the
 * last one is drawn again. A code block, and a list with blank lines between its items, stay in one piece: the
 * whole answer must look the same once it is complete and drawn in one go.
 */
export function splitBlocks(text: string): string[] {
  const parts: string[] = [];
  let current: string[] = [];
  let inFence = false;
  let blank = false;
  const flush = () => {
    if (current.length) parts.push(current.join("\n"));
    current = [];
  };
  for (const line of text.split("\n")) {
    const fence = /^\s*```/.test(line);
    if (!inFence && !line.trim()) {
      blank = true;
      current.push(line);
      continue;
    }
    if (blank && !inFence) {
      const listGoesOn = (LIST_ITEM.test(line) || /^\s/.test(line)) && current.some((l) => LIST_ITEM.test(l));
      if (!listGoesOn) {
        while (current.length && !current.at(-1)!.trim()) current.pop();
        flush();
      }
    }
    blank = false;
    current.push(line);
    if (fence) inFence = !inFence;
  }
  flush();
  return parts;
}
