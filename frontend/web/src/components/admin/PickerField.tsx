"use client";

import { Picker, type PickerOption } from "@/components/ui/Picker";

/**
 * A form row with the app's Picker instead of a native <select>. Not wrapped in a <label> like `Field`: a click on
 * an option inside a label would re-activate the trigger. The trigger is named by `label` (aria-label).
 */
export function PickerField({
  label,
  value,
  options,
  onChange,
  hint,
  placeholder,
}: {
  label: string;
  value: string;
  options: PickerOption[];
  onChange: (v: string) => void;
  hint?: string;
  placeholder?: string;
}) {
  return (
    <div className="grid min-w-0 content-start gap-1.5">
      <span className="text-sm font-medium" aria-hidden="true">
        {label}
      </span>
      <Picker variant="field" label={label} value={value} options={options} onChange={onChange} placeholder={placeholder} />
      {hint ? <span className="text-ink-2 text-xs">{hint}</span> : null}
    </div>
  );
}
