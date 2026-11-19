"use client";

import { ConfirmCard, SourceChips, ToolChips } from "./McpToolBits";
import type { PendingCard, Source, ToolChip } from "./mention-types";

/**
 * What goes around an AI answer outside Hỏi đáp (a chat channel's private turn, a task's comments): what it did, what
 * it read, and a change waiting for the person's yes. Loaded on demand by those screens, so neither pays for it until
 * someone mentions the AI.
 */
export function MentionSteps({ tools }: { tools?: ToolChip[] | undefined }) {
  return tools?.length ? <ToolChips calls={tools} /> : null;
}

export function MentionExtras({
  sources,
  confirm,
  onDecide,
}: {
  sources?: Source[] | undefined;
  confirm?: PendingCard | undefined;
  /** Absent while a decision is being sent: the card's buttons are off. */
  onDecide?: ((approve: boolean) => void | Promise<unknown>) | undefined;
}) {
  return (
    <>
      <SourceChips sources={sources} />
      {confirm ? <ConfirmCard card={confirm} onDecide={onDecide} /> : null}
    </>
  );
}
