import { countryFromZone, isCountry, type Country } from "@/lib/country";

/**
 * The holiday preset to offer first: the country the workspace set in Settings, else its time zone (a London company
 * is in the UK whatever its language), else Vietnamese meaning Vietnam. Null when nothing tells: no country's holidays
 * are suggested to a company elsewhere.
 */
export function defaultHolidayCountry(timeZone: string | null | undefined, locale: string | null | undefined, country?: string | null): Country | null {
  if (isCountry(country)) return country;
  return countryFromZone(timeZone, locale);
}
