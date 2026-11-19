import { cx } from "@/lib/ui";

/**
 * Property list: muted label column (112 px) on the left, the value on the right. Values are usually
 * a ghost button opening a `Menu` (use `propertyValue` for its classes) so the panel reads as data, not a form.
 */
export function PropertyList({ children, className, label }: { children: React.ReactNode; className?: string; label?: string }) {
  return (
    <dl aria-label={label} className={cx("m-0 grid gap-0.5", className)}>
      {children}
    </dl>
  );
}

export function PropertyRow({
  label,
  children,
  htmlFor,
  icon,
  className,
}: {
  className?: string;
  label: React.ReactNode;
  children: React.ReactNode;
  htmlFor?: string;
  /** A muted icon before the label: lets the eye find a field without reading every label. */
  icon?: React.ReactNode;
}) {
  return (
    <div className={cx("grid min-h-8 items-center gap-2", icon ? "grid-cols-[16px_92px_minmax(0,1fr)]" : "grid-cols-[112px_minmax(0,1fr)]", className)}>
      {icon ? (
        <span aria-hidden="true" className="text-ink-2 grid place-items-center [&_svg]:size-4">
          {icon}
        </span>
      ) : null}
      <dt className="text-ink-2 truncate text-sm">{htmlFor ? <label htmlFor={htmlFor}>{label}</label> : label}</dt>
      <dd className="m-0 min-w-0">{children}</dd>
    </div>
  );
}

/** The ghost button a property value sits in (opens its picker). */
export const propertyValue =
  "inline-flex max-w-full min-h-8 items-center gap-2 truncate rounded-md px-2 -mx-2 text-left text-sm text-ink transition-colors hover:bg-ink/5 focus-visible:bg-ink/5 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-ink-2";
