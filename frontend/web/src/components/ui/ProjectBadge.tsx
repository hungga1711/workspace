import { toneAt, toneIndex } from "@/lib/identity";
import { cx } from "@/lib/ui";

const SIZES = {
  xs: "size-4 rounded-[3px] text-[11px] leading-none",
  sm: "size-5 rounded-sm text-[11px]",
  md: "size-7 rounded-md text-xs",
  lg: "size-10 rounded-lg text-base",
} as const;

/**
 * A project's picture: a square tile in its identity colour (by id, so it never changes with a rename) with the name's
 * first letter in white. Rows of projects scan by colour before anyone reads a name.
 */
export function ProjectBadge({ id, name, size = "md", className }: { id: string; name: string; size?: keyof typeof SIZES; className?: string }) {
  const letter = Array.from(name.trim())[0]?.toLocaleUpperCase("vi") ?? "?";
  return (
    <span aria-hidden="true" className={cx(toneAt(toneIndex(id)).wash, "text-ink inline-grid shrink-0 select-none place-items-center font-medium", SIZES[size], className)}>
      {letter}
    </span>
  );
}
