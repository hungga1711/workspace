import { cx } from "@/lib/ui";

/**
 * The app's own reaction set: drawn for this app, chunky shapes with a two-tone shade and a highlight
 * (public/reactions/*.svg). Reactions are still stored as the emoji character, so old reactions, notifications and
 * other clients keep working; anything outside the set shows as the emoji itself.
 */
export const REACTION_ART: Record<string, string> = {
  "👍": "thumbs",
  "❤️": "heart",
  "😂": "laugh",
  "🎉": "party",
  "✅": "done",
  "👀": "eyes",
  "🙏": "thanks",
  "🔥": "fire",
  "💯": "hundred",
  "🙌": "raise",
  "👏": "clap",
  "🚀": "rocket",
  "😀": "grin",
  "😊": "smile",
  "😉": "wink",
  "😍": "love",
  "🤔": "think",
  "😅": "sweat",
  "😢": "cry",
  "😮": "wow",
  "😴": "sleep",
  "🤝": "deal",
  "💪": "strong",
  "👌": "okhand",
};
/** The reaction picker's order: the everyday answers first, then feelings. */
export const REACTION_SET = Object.keys(REACTION_ART);

export function ReactionArt({ emoji, size = 18, className }: { emoji: string; size?: number; className?: string }) {
  const art = REACTION_ART[emoji];
  if (!art)
    return (
      <span className={cx("leading-none", className)} style={{ fontSize: size * 0.85 }}>
        {emoji}
      </span>
    );
  return <img src={`/reactions/${art}.svg`} alt={emoji} width={size} height={size} draggable={false} className={cx("shrink-0 select-none", className)} />;
}
