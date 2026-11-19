"use client";

import type { Source } from "../mention-types";
import { AnswerBlocks } from "./AnswerBlocks";
import { EntityCards } from "./EntityCards";
import type { AnswerBlock } from "./types";

/**
 * What goes under an answer besides its words: its charts and tables, and cards for the tasks, people,
 * pages and meetings it named. Loaded on demand, only for answers that have any of it. `onAsk` puts a follow-up in the
 * composer (a drill that asks); without it, those drills are plain. The next steps are NextSteps, beside the follow-ups.
 */
export default function AnswerExtras({ blocks, cards, onAsk }: { blocks: AnswerBlock[]; cards: Source[]; onAsk?: ((text: string) => void) | undefined }) {
  return (
    <>
      <AnswerBlocks blocks={blocks} onAsk={onAsk} />
      <EntityCards items={cards} />
    </>
  );
}
