// A plain module (no "use client"): the server page picks the request form's currency with it.

/**
 * The currency a request form starts with when the admin has not set one (Admin › Settings › currency): the
 * workspace's time zone says where the company is far better than a fixed VND does (a London company pays in GBP).
 * Only currencies the form offers (lib/money CURRENCIES); anything else falls back by language.
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

export function defaultCurrency(configured: string | null | undefined, timeZone: string, locale: string): string {
  if (configured) return configured;
  for (const [re, cur] of BY_ZONE) if (re.test(timeZone)) return cur;
  return locale === "vi" ? "VND" : "USD";
}
