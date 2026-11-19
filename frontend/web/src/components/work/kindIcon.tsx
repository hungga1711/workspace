import { CalendarIcon, CardIcon, CartIcon, CashIcon, FileIcon, PlaneIcon } from "@/components/app/icons";
import { cx } from "@/lib/ui";

export type RequestKind = "purchase" | "payment" | "advance" | "trip" | "leave" | "other";

const ICONS: Record<RequestKind, (p: { className?: string }) => React.JSX.Element> = {
  purchase: CartIcon,
  payment: CardIcon,
  advance: CashIcon,
  trip: PlaneIcon,
  leave: CalendarIcon,
  other: FileIcon,
};

/**
 * The tile in front of a request: a line icon for the built-in kinds, or the emoji a company
 * template chose (Vận hành › Mẫu yêu cầu).
 */
export function KindTile({ kind, emoji, size = "md" }: { kind: RequestKind; emoji?: string | null; size?: "md" | "lg" }) {
  const Icon = ICONS[kind] ?? FileIcon;
  return (
    <span
      aria-hidden="true"
      className={cx("border-hairline bg-surface text-ink grid shrink-0 place-items-center rounded-lg border", size === "lg" ? "size-11 rounded-xl text-xl" : "size-9 text-base")}
    >
      {emoji && emoji !== "📝" ? emoji : <Icon className={size === "lg" ? "size-5" : "size-[18px]"} />}
    </span>
  );
}

export function KindIcon({ kind, className = "size-3.5" }: { kind: RequestKind; className?: string }) {
  const Icon = ICONS[kind] ?? FileIcon;
  return <Icon className={className} />;
}
