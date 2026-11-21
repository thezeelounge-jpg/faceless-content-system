// Best posting times (docs/PRODUCT.md "Planning rules"). Pure: no database,
// no clock. The owner tunes the starting values below over time.
//
// Rules, in order:
// 1. The PRIMARY country is the brand's first audience country (Pakistan when
//    none). Its timezone, weekend and times are used for every post, because
//    one video goes out once. Other countries in the list don't change the time.
// 2. The brand's posting_times_override ({ instagram: "HH:MM", ... }, local to
//    the primary country) wins when present.
// 3. Otherwise, during Ramadan (dates from app_settings "ramadan"), every
//    network moves to after iftar / late evening.
// 4. Otherwise, weekend times on the country's weekend, workday times on others.
// 5. Friday, in Pakistan and the GCC only (JUMUAH_COUNTRIES): a time inside
//    the Jumu'ah window (12:30 to 14:30 local) moves to 14:30. This applies
//    to overrides too. Other countries (GB, US, ...) keep their Friday times.
// All times are returned as UTC Date objects (stored as timestamptz).

export const NETWORKS = ["instagram", "tiktok", "linkedin", "x"] as const;
export type Network = (typeof NETWORKS)[number];

type DayTimes = Record<Network, string>;
type CountryRule = { timezone: string; weekend: number[]; times?: { workday: DayTimes; weekend: DayTimes } };

const SAT_SUN = [6, 0];
const FRI_SAT = [5, 6];

/** Used for countries without their own times. */
export const DEFAULT_TIMES: { workday: DayTimes; weekend: DayTimes } = {
  workday: { instagram: "19:00", tiktok: "20:00", linkedin: "09:00", x: "12:00" },
  weekend: { instagram: "11:00", tiktok: "20:00", linkedin: "10:00", x: "11:00" },
};

/** During Ramadan: after iftar and late evening, every country. */
export const RAMADAN_TIMES: DayTimes = { instagram: "21:30", tiktok: "22:30", linkedin: "21:00", x: "22:00" };

/** Friday Jumu'ah prayer window (local time). Never post inside it in JUMUAH_COUNTRIES. */
export const FRIDAY_PRAYER = { start: "12:30", end: "14:30" } as const;

/** Where the Friday window applies (Rowan's decision, Nov 2026): Pakistan and the GCC. */
export const JUMUAH_COUNTRIES: readonly string[] = ["PK", "AE", "SA", "QA", "KW", "BH", "OM"];

export const DEFAULT_COUNTRY = "PK";

// ---------------------------------------------------------------------------
// POSTING TIMES TABLE: STARTING DEFAULTS, PENDING REVIEW BEFORE LAUNCH.
// These are educated guesses, not measured data. Review them (and DEFAULT_TIMES
// and RAMADAN_TIMES above) before launch, then tune from real results.
// ---------------------------------------------------------------------------
/** 0 = Sunday ... 6 = Saturday. Keys are the ISO codes in lib/brand-input.ts COUNTRIES. */
export const COUNTRY_RULES: Record<string, CountryRule> = {
  PK: {
    timezone: "Asia/Karachi",
    weekend: SAT_SUN,
    times: {
      workday: { instagram: "20:00", tiktok: "21:00", linkedin: "10:00", x: "13:00" },
      weekend: { instagram: "21:00", tiktok: "21:30", linkedin: "11:00", x: "20:00" },
    },
  },
  AE: {
    timezone: "Asia/Dubai",
    weekend: SAT_SUN,
    times: {
      workday: { instagram: "19:00", tiktok: "20:00", linkedin: "08:30", x: "12:00" },
      weekend: { instagram: "20:00", tiktok: "21:00", linkedin: "10:00", x: "19:00" },
    },
  },
  SA: {
    timezone: "Asia/Riyadh",
    weekend: FRI_SAT,
    times: {
      workday: { instagram: "21:00", tiktok: "22:00", linkedin: "09:00", x: "13:00" },
      weekend: { instagram: "21:30", tiktok: "22:30", linkedin: "11:00", x: "21:00" },
    },
  },
  QA: {
    timezone: "Asia/Qatar",
    weekend: FRI_SAT,
    times: {
      workday: { instagram: "20:00", tiktok: "21:00", linkedin: "09:00", x: "13:00" },
      weekend: { instagram: "21:00", tiktok: "22:00", linkedin: "11:00", x: "20:00" },
    },
  },
  KW: { timezone: "Asia/Kuwait", weekend: FRI_SAT },
  OM: { timezone: "Asia/Muscat", weekend: FRI_SAT },
  BH: { timezone: "Asia/Bahrain", weekend: FRI_SAT },
  IN: { timezone: "Asia/Kolkata", weekend: SAT_SUN },
  GB: { timezone: "Europe/London", weekend: SAT_SUN },
  US: { timezone: "America/New_York", weekend: SAT_SUN },
  CA: { timezone: "America/Toronto", weekend: SAT_SUN },
};

/** Unknown country codes: UTC, Saturday-Sunday weekend, default times. */
const UNKNOWN_COUNTRY: CountryRule = { timezone: "UTC", weekend: SAT_SUN };

export type RamadanDates = { start: string | null; end: string | null };

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function ruleFor(country: string | undefined): CountryRule {
  return COUNTRY_RULES[country ?? DEFAULT_COUNTRY] ?? UNKNOWN_COUNTRY;
}

export function primaryCountry(countries: string[] | null | undefined): string {
  return countries?.[0] ?? DEFAULT_COUNTRY;
}

export function timezoneFor(countries: string[] | null | undefined): string {
  return ruleFor(primaryCountry(countries)).timezone;
}

/** Weekday of a calendar date "YYYY-MM-DD" (0 = Sunday). */
export function weekdayOf(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function isWeekend(date: string, country: string): boolean {
  return ruleFor(country).weekend.includes(weekdayOf(date));
}

/** True when `date` is between the Ramadan start and end dates (both included). */
export function isRamadan(date: string, ramadan: RamadanDates | null | undefined): boolean {
  if (!ramadan?.start || !ramadan?.end || !DATE.test(ramadan.start) || !DATE.test(ramadan.end)) return false;
  return date >= ramadan.start && date <= ramadan.end;
}

/** "HH:MM" of a moment in a timezone. */
export function localTimeString(moment: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(moment);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("hour")}:${get("minute")}`;
}

/** "YYYY-MM-DD" of a moment in a timezone. */
export function localDateString(moment: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    moment,
  );
}

/** Minutes the timezone is ahead of UTC at that moment (handles daylight saving). */
function offsetMinutes(moment: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(moment);
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
  return Math.round((asUtc - moment.getTime()) / 60_000);
}

/** The UTC moment of a local date and "HH:MM" in a timezone. */
export function zonedTimeToUtc(date: string, time: string, timezone: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const naive = Date.UTC(y, m - 1, d, hh, mm);
  let result = naive - offsetMinutes(new Date(naive), timezone) * 60_000;
  // Check once more at the result (the offset may differ across a DST change).
  result = naive - offsetMinutes(new Date(result), timezone) * 60_000;
  return new Date(result);
}

function overrideTime(override: unknown, network: Network): string | null {
  if (!override || typeof override !== "object") return null;
  const value = (override as Record<string, unknown>)[network];
  return typeof value === "string" && HHMM.test(value.trim()) ? value.trim() : null;
}

export type PostingTimeArgs = {
  /** Local calendar date in the primary country, "YYYY-MM-DD". */
  date: string;
  countries: string[] | null | undefined;
  ramadan?: RamadanDates | null;
  /** brands.posting_times_override, e.g. { instagram: "19:30" }. */
  override?: unknown;
};

/** The local "HH:MM" for one network on one date, after every rule. */
export function localPostingTime({ date, countries, ramadan, override, network }: PostingTimeArgs & { network: Network }): string {
  const country = primaryCountry(countries);
  const rule = ruleFor(country);
  const table = rule.times ?? DEFAULT_TIMES;
  let time =
    overrideTime(override, network) ??
    (isRamadan(date, ramadan)
      ? RAMADAN_TIMES[network]
      : rule.weekend.includes(weekdayOf(date))
        ? table.weekend[network]
        : table.workday[network]);
  const inPrayerWindow = time >= FRIDAY_PRAYER.start && time < FRIDAY_PRAYER.end;
  if (weekdayOf(date) === 5 && JUMUAH_COUNTRIES.includes(country) && inPrayerWindow) time = FRIDAY_PRAYER.end;
  return time;
}

/** The UTC moment to post on one network. */
export function postingTimeUtc(args: PostingTimeArgs & { network: Network }): Date {
  return zonedTimeToUtc(args.date, localPostingTime(args), timezoneFor(args.countries));
}

/** The UTC moment for every network on one date. */
export function bestPostingTimes(args: PostingTimeArgs): Record<Network, Date> {
  return Object.fromEntries(NETWORKS.map((network) => [network, postingTimeUtc({ ...args, network })])) as Record<
    Network,
    Date
  >;
}
