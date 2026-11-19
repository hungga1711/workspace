/**
 * A form row for a popover control (Picker, DateField). Not a <label>: a click inside a label re-clicks its first
 * button, which would reopen the popover the user just picked from. The control carries its own accessible name.
 */
export function FormField({ label, hint, error, children }: { label: string; hint?: string; error?: string | null; children: React.ReactNode }) {
  return (
    <div className="grid min-w-0 content-start gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {error ? <span className="text-block text-xs">{error}</span> : hint ? <span className="text-ink-2 text-xs">{hint}</span> : null}
    </div>
  );
}
