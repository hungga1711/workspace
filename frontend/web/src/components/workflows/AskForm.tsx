/**
 * Tells the chat sidebar's "AI is asking" list to read again (it otherwise reads every half minute). Sent by the run's
 * conversation (components/chat/AskConversation.tsx) after an answer, an approval or the end of a run.
 */
export const ASKS_CHANGED = "wos:asks-changed";
export const asksChanged = () => window.dispatchEvent(new Event(ASKS_CHANGED));
