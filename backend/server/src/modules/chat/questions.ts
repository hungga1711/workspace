/**
 * Whether a chat message asks something of its reader: a question or a request. Used to find the questions
 * nobody answered (the AI's unanswered_questions and needs_my_attention). Vietnamese questions often have no "?"
 * ("xong chưa", "anh xem giúp em được không"), so the common question and request phrases count too. Leaning to
 * yes is fine: the list is only of messages that mention the person or came to them directly.
 */
const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase();

/** Phrases (accents folded) that make a question or a request anywhere in the message. */
const PHRASES = [
  "duoc khong",
  "duoc chua",
  "co khong",
  "khong a",
  "chua a",
  "khi nao",
  "bao gio",
  "o dau",
  "the nao",
  "nhu nao",
  "bao nhieu",
  "tai sao",
  "vi sao",
  "lam sao",
  "nho anh",
  "nho chi",
  "nho em",
  "nho ban",
  "giup em",
  "giup anh",
  "giup chi",
  "giup minh",
  "giup toi",
  "can you",
  "could you",
  "would you",
  "can someone",
  "any update",
  "please",
  "pls",
];
/** Words that make a question when the message starts with them. */
const OPENERS = ["can", "could", "would", "will", "do", "does", "did", "is", "are", "should", "when", "where", "what", "who", "why", "how", "which", "anyone", "ai"];
/** Words that make a question when the message ends with them ("xong chưa", "ổn không", "đúng nhỉ"). */
const ENDINGS = ["khong", "chua", "nhi", "nhe", "sao", "gi"];

export function looksLikeQuestion(body: string): boolean {
  // Quotes and code are someone else's words: "> is this right?" quoted in an answer is not a new question.
  const text = body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith(">"))
    .join(" ")
    .replace(/https?:\/\/\S+/g, " ")
    .trim();
  if (!text) return false;
  if (text.includes("?")) return true;
  const words = fold(text)
    .replace(/<@[^>]+>|@\S+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return false;
  const joined = ` ${words.join(" ")} `;
  if (PHRASES.some((p) => joined.includes(` ${p} `))) return true;
  // "ai" (who) opens a Vietnamese question, but a message about AI is not one: only with a verb-like follow-up.
  if (OPENERS.includes(words[0]!) && (words[0] !== "ai" || ["lam", "biet", "co", "xem", "giup", "dang"].includes(words[1] ?? ""))) return words.length > 1;
  return ENDINGS.includes(words.at(-1)!) && words.length > 1;
}
