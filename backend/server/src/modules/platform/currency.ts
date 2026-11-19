/**
 * The currency a new workspace starts with: its time zone says where the company is far better than a fixed VND
 * does (a London company pays in GBP). Admins can still change it; the web keeps the same mapping for older rows
 * that have none (frontend/web/src/components/work/defaultCurrency.ts).
 */
const BY_ZONE: [RegExp, string][] = [
  [/^Asia\/(Ho_Chi_Minh|Saigon)$/, "VND"],
  [/^Europe\/(London|Belfast|Guernsey|Isle_of_Man|Jersey)$/, "GBP"],
  [
    /^Europe\/(Amsterdam|Athens|Berlin|Bratislava|Brussels|Dublin|Helsinki|Lisbon|Ljubljana|Luxembourg|Madrid|Malta|Monaco|Paris|Riga|Rome|San_Marino|Tallinn|Vatican|Vienna|Vilnius|Zagreb)$/,
    "EUR",
  ],
  [/^Asia\/Tokyo$/, "JPY"],
  [/^Asia\/Singapore$/, "SGD"],
  [/^Asia\/Bangkok$/, "THB"],
  [/^Asia\/Seoul$/, "KRW"],
  [/^Asia\/(Shanghai|Chongqing|Harbin|Urumqi)$/, "CNY"],
  [/^Australia\//, "AUD"],
  [/^(America\/(New_York|Chicago|Denver|Los_Angeles|Phoenix|Anchorage|Detroit|Indiana\/.+|Kentucky\/.+|Boise)|Pacific\/Honolulu)$/, "USD"],
];

export function currencyFor(timeZone: string, locale: string): string {
  for (const [re, cur] of BY_ZONE) if (re.test(timeZone)) return cur;
  return locale === "vi" ? "VND" : "USD";
}

/** The currency of a country the setup form offers (web lib/country.ts keeps the same list). */
export const CURRENCY_BY_COUNTRY: Record<string, string> = { US: "USD", GB: "GBP", VN: "VND", CN: "CNY", ES: "EUR", MX: "MXN", SG: "SGD", JP: "JPY" };
