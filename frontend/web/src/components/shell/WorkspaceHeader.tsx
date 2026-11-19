import { cx } from "@/lib/ui";
import { workspaceInitials } from "@/lib/workspace-initials";
import { BrandMark } from "@/components/ui/BrandMark";

/** A workspace picture: the workspace's own colour with its initials, or the bòn bon mark when not customised. */
export function WorkspaceLogo({ name, color, logoUrl, className }: { name: string; color?: string | null; logoUrl?: string | null; className?: string }) {
  // The company's uploaded logo (Admin › Cài đặt) wins over the colour tile; it is a small mark, so a plain <img>.
  if (logoUrl) return <img src={logoUrl} alt="" className={cx("shrink-0 object-contain", className ?? "size-7")} />;
  if (!color) return <BrandMark className={cx("rounded-md", className ?? "size-7")} />;
  return (
    <span
      className={cx("grid shrink-0 place-items-center rounded-md text-[11px] font-semibold text-white", className ?? "size-7")}
      style={{ backgroundColor: color }}
      aria-hidden="true"
    >
      {workspaceInitials(name)}
    </span>
  );
}
