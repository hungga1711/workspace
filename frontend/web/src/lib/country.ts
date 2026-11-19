/**
 * Where the company is decides its defaults: public holidays, the statutory minimum of annual leave, the currency and
 * the work week. One table, used by /setup, Admin › Settings, Holidays and the leave policy, so a London, Madrid or
 * Shanghai company is not handed Vietnam's (or the UK's) rules.
 *
 * Holiday lists are national days only (no regional ones: Spain's autonomous communities, US states) and include the
 * movable feasts for 2026–2027; other years fall back to the fixed-date ones. Governments sometimes move or extend
 * days (Vietnam's Tết, China's make-up working days): the Holidays page says to check the official announcement.
 */
export const COUNTRIES = ["US", "GB", "VN", "CN", "ES", "MX", "SG", "JP"] as const;
export type Country = (typeof COUNTRIES)[number];

export const isCountry = (v: unknown): v is Country => typeof v === "string" && (COUNTRIES as readonly string[]).includes(v);

interface CountryRules {
  currency: string;
  /** ISO weekdays, Monday = 1. */
  workWeek: number[];
  /** Days of paid annual leave a company starts from (the statutory minimum, or a common default where there is none). */
  leaveDays: number;
  /** Whether that figure is the law's minimum (true) or only a usual company default (false: the US has none). */
  leaveStatutory: boolean;
  /** Fixed-date national holidays, month-day → name in the country's language. */
  fixed: [string, string][];
  /** Every national holiday of a year, movable ones and substitute days included, where we ship the list. */
  years: Record<number, [string, string][]>;
}

const MON_FRI = [1, 2, 3, 4, 5];

export const COUNTRY_RULES: Record<Country, CountryRules> = {
  US: {
    currency: "USD",
    workWeek: MON_FRI,
    leaveDays: 15,
    leaveStatutory: false,
    fixed: [
      ["01-01", "New Year's Day"],
      ["06-19", "Juneteenth"],
      ["07-04", "Independence Day"],
      ["11-11", "Veterans Day"],
      ["12-25", "Christmas Day"],
    ],
    // Federal holidays; one on a Saturday is observed on the Friday, on a Sunday on the Monday.
    years: {
      2026: [
        ["01-01", "New Year's Day"],
        ["01-19", "Martin Luther King Jr. Day"],
        ["02-16", "Presidents' Day"],
        ["05-25", "Memorial Day"],
        ["06-19", "Juneteenth"],
        ["07-03", "Independence Day (observed)"],
        ["09-07", "Labor Day"],
        ["10-12", "Columbus Day"],
        ["11-11", "Veterans Day"],
        ["11-26", "Thanksgiving Day"],
        ["12-25", "Christmas Day"],
      ],
      2027: [
        ["01-01", "New Year's Day"],
        ["01-18", "Martin Luther King Jr. Day"],
        ["02-15", "Presidents' Day"],
        ["05-31", "Memorial Day"],
        ["06-18", "Juneteenth (observed)"],
        ["07-05", "Independence Day (observed)"],
        ["09-06", "Labor Day"],
        ["10-11", "Columbus Day"],
        ["11-11", "Veterans Day"],
        ["11-25", "Thanksgiving Day"],
        ["12-24", "Christmas Day (observed)"],
      ],
    },
  },
  GB: {
    currency: "GBP",
    workWeek: MON_FRI,
    // 5.6 weeks a year by law; with the 8 bank holidays below counted as holidays, 20 days are left as annual leave.
    leaveDays: 20,
    leaveStatutory: true,
    fixed: [
      ["01-01", "New Year's Day"],
      ["12-25", "Christmas Day"],
      ["12-26", "Boxing Day"],
    ],
    // England and Wales bank holidays.
    years: {
      2026: [
        ["01-01", "New Year's Day"],
        ["04-03", "Good Friday"],
        ["04-06", "Easter Monday"],
        ["05-04", "Early May bank holiday"],
        ["05-25", "Spring bank holiday"],
        ["08-31", "Summer bank holiday"],
        ["12-25", "Christmas Day"],
        ["12-28", "Boxing Day (substitute day)"],
      ],
      2027: [
        ["01-01", "New Year's Day"],
        ["03-26", "Good Friday"],
        ["03-29", "Easter Monday"],
        ["05-03", "Early May bank holiday"],
        ["05-31", "Spring bank holiday"],
        ["08-30", "Summer bank holiday"],
        ["12-27", "Christmas Day (substitute day)"],
        ["12-28", "Boxing Day (substitute day)"],
      ],
    },
  },
  VN: {
    currency: "VND",
    workWeek: MON_FRI,
    // Labour Code art. 113: 12 days for normal work (+1 per 5 years of service, art. 114).
    leaveDays: 12,
    leaveStatutory: true,
    fixed: [
      ["01-01", "Tết Dương lịch"],
      ["04-30", "Ngày Giải phóng miền Nam"],
      ["05-01", "Ngày Quốc tế Lao động"],
      ["09-02", "Quốc khánh"],
    ],
    years: {
      2026: [
        ["01-01", "Tết Dương lịch"],
        ["02-16", "Tết Nguyên đán"],
        ["02-17", "Tết Nguyên đán"],
        ["02-18", "Tết Nguyên đán"],
        ["02-19", "Tết Nguyên đán"],
        ["02-20", "Tết Nguyên đán"],
        ["04-27", "Giỗ Tổ Hùng Vương (nghỉ bù)"],
        ["04-30", "Ngày Giải phóng miền Nam"],
        ["05-01", "Ngày Quốc tế Lao động"],
        ["09-01", "Quốc khánh"],
        ["09-02", "Quốc khánh"],
      ],
      2027: [
        ["01-01", "Tết Dương lịch"],
        ["02-05", "Tết Nguyên đán"],
        ["02-08", "Tết Nguyên đán"],
        ["02-09", "Tết Nguyên đán"],
        ["02-10", "Tết Nguyên đán"],
        ["02-11", "Tết Nguyên đán"],
        ["04-16", "Giỗ Tổ Hùng Vương"],
        ["04-30", "Ngày Giải phóng miền Nam"],
        ["05-03", "Ngày Quốc tế Lao động (nghỉ bù)"],
        ["09-02", "Quốc khánh"],
        ["09-03", "Quốc khánh"],
      ],
    },
  },
  CN: {
    currency: "CNY",
    workWeek: MON_FRI,
    // 5 days after one year of work, 10 after ten, 15 after twenty (Regulations on Paid Annual Leave).
    leaveDays: 5,
    leaveStatutory: true,
    fixed: [
      ["01-01", "元旦"],
      ["05-01", "劳动节"],
      ["05-02", "劳动节"],
      ["10-01", "国庆节"],
      ["10-02", "国庆节"],
      ["10-03", "国庆节"],
    ],
    // Statutory days only; the State Council's yearly schedule adds bridge days and make-up working weekends.
    years: {
      2026: [
        ["01-01", "元旦"],
        ["02-16", "春节"],
        ["02-17", "春节"],
        ["02-18", "春节"],
        ["02-19", "春节"],
        ["04-05", "清明节"],
        ["05-01", "劳动节"],
        ["05-02", "劳动节"],
        ["06-19", "端午节"],
        ["09-25", "中秋节"],
        ["10-01", "国庆节"],
        ["10-02", "国庆节"],
        ["10-03", "国庆节"],
      ],
      2027: [
        ["01-01", "元旦"],
        ["02-05", "春节"],
        ["02-06", "春节"],
        ["02-07", "春节"],
        ["02-08", "春节"],
        ["04-05", "清明节"],
        ["05-01", "劳动节"],
        ["05-02", "劳动节"],
        ["06-09", "端午节"],
        ["09-15", "中秋节"],
        ["10-01", "国庆节"],
        ["10-02", "国庆节"],
        ["10-03", "国庆节"],
      ],
    },
  },
  ES: {
    currency: "EUR",
    workWeek: MON_FRI,
    // 30 calendar days by law (Estatuto de los Trabajadores art. 38), which is 22 working days.
    leaveDays: 22,
    leaveStatutory: true,
    fixed: [
      ["01-01", "Año Nuevo"],
      ["01-06", "Epifanía del Señor"],
      ["05-01", "Fiesta del Trabajo"],
      ["08-15", "Asunción de la Virgen"],
      ["10-12", "Fiesta Nacional de España"],
      ["11-01", "Todos los Santos"],
      ["12-06", "Día de la Constitución"],
      ["12-08", "Inmaculada Concepción"],
      ["12-25", "Navidad"],
    ],
    // National days; each autonomous community and town adds its own.
    years: {
      2026: [
        ["01-01", "Año Nuevo"],
        ["01-06", "Epifanía del Señor"],
        ["04-03", "Viernes Santo"],
        ["05-01", "Fiesta del Trabajo"],
        ["08-15", "Asunción de la Virgen"],
        ["10-12", "Fiesta Nacional de España"],
        ["11-01", "Todos los Santos"],
        ["12-06", "Día de la Constitución"],
        ["12-08", "Inmaculada Concepción"],
        ["12-25", "Navidad"],
      ],
      2027: [
        ["01-01", "Año Nuevo"],
        ["01-06", "Epifanía del Señor"],
        ["03-26", "Viernes Santo"],
        ["05-01", "Fiesta del Trabajo"],
        ["08-15", "Asunción de la Virgen"],
        ["10-12", "Fiesta Nacional de España"],
        ["11-01", "Todos los Santos"],
        ["12-06", "Día de la Constitución"],
        ["12-08", "Inmaculada Concepción"],
        ["12-25", "Navidad"],
      ],
    },
  },
  MX: {
    currency: "MXN",
    workWeek: MON_FRI,
    // 12 days in the first year since the 2023 reform (Ley Federal del Trabajo art. 76), rising with seniority.
    leaveDays: 12,
    leaveStatutory: true,
    fixed: [
      ["01-01", "Año Nuevo"],
      ["05-01", "Día del Trabajo"],
      ["09-16", "Día de la Independencia"],
      ["12-25", "Navidad"],
    ],
    // Días de descanso obligatorio (LFT art. 74); three fall on a Monday.
    years: {
      2026: [
        ["01-01", "Año Nuevo"],
        ["02-02", "Día de la Constitución"],
        ["03-16", "Natalicio de Benito Juárez"],
        ["05-01", "Día del Trabajo"],
        ["09-16", "Día de la Independencia"],
        ["11-16", "Día de la Revolución"],
        ["12-25", "Navidad"],
      ],
      2027: [
        ["01-01", "Año Nuevo"],
        ["02-01", "Día de la Constitución"],
        ["03-15", "Natalicio de Benito Juárez"],
        ["05-01", "Día del Trabajo"],
        ["09-16", "Día de la Independencia"],
        ["11-15", "Día de la Revolución"],
        ["12-25", "Navidad"],
      ],
    },
  },
  SG: {
    currency: "SGD",
    workWeek: MON_FRI,
    leaveDays: 7,
    leaveStatutory: true,
    fixed: [
      ["01-01", "New Year's Day"],
      ["05-01", "Labour Day"],
      ["08-09", "National Day"],
      ["12-25", "Christmas Day"],
    ],
    years: {},
  },
  JP: {
    currency: "JPY",
    workWeek: MON_FRI,
    leaveDays: 10,
    leaveStatutory: true,
    fixed: [
      ["01-01", "元日"],
      ["02-11", "建国記念の日"],
      ["02-23", "天皇誕生日"],
      ["04-29", "昭和の日"],
      ["05-03", "憲法記念日"],
      ["05-04", "みどりの日"],
      ["05-05", "こどもの日"],
      ["08-11", "山の日"],
      ["11-03", "文化の日"],
      ["11-23", "勤労感謝の日"],
    ],
    years: {},
  },
};

/** The national holidays of `year` as YYYY-MM-DD → name: the full list where we ship one, else the fixed-date days. */
export function holidaysFor(country: Country, year: number): { day: string; name: string }[] {
  const r = COUNTRY_RULES[country];
  return (r.years[year] ?? r.fixed).map(([md, name]) => ({ day: `${year}-${md}`, name }));
}

/** Whether `holidaysFor` has the movable feasts for that year (otherwise only fixed-date days). */
export const hasFullYear = (country: Country, year: number) => !!COUNTRY_RULES[country].years[year];

const BY_ZONE: [RegExp, Country][] = [
  [/^Asia\/(Ho_Chi_Minh|Saigon)$/, "VN"],
  [/^Europe\/(London|Belfast|Guernsey|Isle_of_Man|Jersey)$/, "GB"],
  [/^(Europe\/Madrid|Atlantic\/Canary|Africa\/Ceuta)$/, "ES"],
  [/^Asia\/(Shanghai|Chongqing|Chungking|Harbin|Urumqi)$/, "CN"],
  [/^(America\/(Mexico_City|Cancun|Merida|Monterrey|Matamoros|Chihuahua|Ciudad_Juarez|Ojinaga|Mazatlan|Bahia_Banderas|Hermosillo|Tijuana)|Mexico\/.+)$/, "MX"],
  [/^Asia\/Singapore$/, "SG"],
  [/^Asia\/Tokyo$/, "JP"],
  [
    /^(America\/(New_York|Chicago|Denver|Los_Angeles|Phoenix|Anchorage|Detroit|Boise|Juneau|Sitka|Nome|Adak|Menominee|Metlakatla|Yakutat)|America\/(Indiana|Kentucky|North_Dakota)\/.+|US\/.+|Pacific\/Honolulu)$/,
    "US",
  ],
];

/**
 * The country a workspace most likely sits in: its time zone first (a London company is in the UK whatever its
 * language), then the language where it names one country. Null when neither tells.
 */
export function countryFromZone(timeZone: string | null | undefined, locale?: string | null): Country | null {
  if (timeZone) for (const [re, c] of BY_ZONE) if (re.test(timeZone)) return c;
  // Vietnamese says Vietnam only when the zone does not say elsewhere (none, UTC, or another Asian zone).
  if (locale === "vi" && (!timeZone || timeZone === "UTC" || timeZone.startsWith("Asia/"))) return "VN";
  return null;
}

/** A country's name in the reader's language (Intl), so the list needs no translations of its own. */
export function regionName(code: string, intlTag: string): string {
  try {
    return new Intl.DisplayNames([intlTag], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}
