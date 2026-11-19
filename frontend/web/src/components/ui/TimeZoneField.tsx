"use client";

import { useMemo } from "react";
import { Picker, type PickerOption } from "@/components/ui/Picker";
import { browserTimeZone, isTimeZone, zoneOffset } from "@/lib/timezone";

/** Zones most of our users are in, listed before the rest; the browser's own zone joins them. */
const SUGGESTED = [
  "Asia/Ho_Chi_Minh",
  "Asia/Bangkok",
  "Asia/Jakarta",
  "Asia/Singapore",
  "Asia/Kuala_Lumpur",
  "Asia/Manila",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Australia/Sydney",
  "Europe/London",
  "Europe/Berlin",
  "America/New_York",
  "America/Los_Angeles",
  "UTC",
];

/** "UTC+07:00" for the zone right now. */
function utcLabel(tz: string): string {
  const minutes = Math.round(zoneOffset(new Date(), tz) / 60_000);
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/**
 * Every IANA zone the browser knows (Intl.supportedValuesOf; a short list on runtimes without it), the suggested
 * ones and the current value first. "Asia/Ho_Chi_Minh (UTC+07:00)", searchable by city.
 */
function timeZoneOptions(current?: string | null): PickerOption[] {
  const known = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ?? SUGGESTED;
  const order = [...new Set([...(current && isTimeZone(current) ? [current] : []), browserTimeZone(), ...SUGGESTED, ...known])];
  return order.map((tz) => ({ value: tz, label: `${tz.replace(/_/g, " ")} (${utcLabel(tz)})`, keywords: tz.replace(/[_/]/g, " ") }));
}

/**
 * A time-zone picker: the full IANA list with a filter box (the Picker shows one for long lists). `extra` rows go
 * first (e.g. "same as the workspace" with an empty value).
 */
export function TimeZoneField({
  label,
  value,
  onChange,
  extra = [],
  variant = "field",
}: {
  label: string;
  value: string;
  onChange: (tz: string) => void;
  extra?: PickerOption[];
  variant?: "field" | "button";
}) {
  const options = useMemo(() => [...extra, ...timeZoneOptions(value)], [extra, value]);
  return <Picker variant={variant} label={label} value={value} options={options} onChange={onChange} />;
}
