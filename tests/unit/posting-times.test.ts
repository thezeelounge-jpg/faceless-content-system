import { describe, expect, it } from "vitest";
import {
  bestPostingTimes,
  COUNTRY_RULES,
  FRIDAY_PRAYER,
  isRamadan,
  isWeekend,
  JUMUAH_COUNTRIES,
  localTimeString,
  NETWORKS,
  postingTimeUtc,
  weekdayOf,
} from "@/lib/posting-times";

// Dates used below (all real calendar days):
// 2026-12-07 Monday, 2026-12-11 Friday, 2026-12-12 Saturday, 2026-12-13 Sunday.
const MON = "2026-12-07";
const FRI = "2026-12-11";
const SAT = "2026-12-12";
const SUN = "2026-12-13";
const iso = (d: Date) => d.toISOString();

describe("calendar helpers", () => {
  it("knows the weekday of a date (0 = Sunday)", () => {
    expect([MON, FRI, SAT, SUN].map(weekdayOf)).toEqual([1, 5, 6, 0]);
  });

  it("each country has its own weekend", () => {
    // Pakistan and UAE: Saturday and Sunday.
    expect(isWeekend(SAT, "PK")).toBe(true);
    expect(isWeekend(SUN, "AE")).toBe(true);
    expect(isWeekend(FRI, "PK")).toBe(false);
    // Saudi Arabia and Qatar: Friday and Saturday.
    expect(isWeekend(FRI, "SA")).toBe(true);
    expect(isWeekend(SAT, "QA")).toBe(true);
    expect(isWeekend(SUN, "SA")).toBe(false);
  });

  it("has a timezone for the four first-market countries", () => {
    expect(COUNTRY_RULES.PK.timezone).toBe("Asia/Karachi");
    expect(COUNTRY_RULES.AE.timezone).toBe("Asia/Dubai");
    expect(COUNTRY_RULES.SA.timezone).toBe("Asia/Riyadh");
    expect(COUNTRY_RULES.QA.timezone).toBe("Asia/Qatar");
  });
});

describe("best posting times", () => {
  it("Pakistan workday: Instagram at 20:00 Karachi time, returned in UTC", () => {
    expect(iso(postingTimeUtc({ date: MON, countries: ["PK"], network: "instagram" }))).toBe("2026-12-07T15:00:00.000Z");
  });

  it("uses weekend times on the country's weekend", () => {
    const pkSat = postingTimeUtc({ date: SAT, countries: ["PK"], network: "instagram" });
    const pkMon = postingTimeUtc({ date: MON, countries: ["PK"], network: "instagram" });
    expect(localTimeString(pkSat, "Asia/Karachi")).not.toBe(localTimeString(pkMon, "Asia/Karachi"));
    // In Saudi Arabia Friday is the weekend, so Friday uses weekend times.
    const saFri = postingTimeUtc({ date: FRI, countries: ["SA"], network: "instagram" });
    const saSat = postingTimeUtc({ date: SAT, countries: ["SA"], network: "instagram" });
    expect(localTimeString(saFri, "Asia/Riyadh")).toBe(localTimeString(saSat, "Asia/Riyadh"));
  });

  it("has a time for every network", () => {
    const times = bestPostingTimes({ date: MON, countries: ["AE"] });
    expect(Object.keys(times).sort()).toEqual([...NETWORKS].sort());
    for (const time of Object.values(times)) expect(time).toBeInstanceOf(Date);
  });

  it("never uses the Friday Jumu'ah window (12:30 to 14:30 local) in Pakistan or the GCC, any network", () => {
    expect([...JUMUAH_COUNTRIES].sort()).toEqual(["AE", "BH", "KW", "OM", "PK", "QA", "SA"]);
    for (const country of JUMUAH_COUNTRIES) {
      for (const network of NETWORKS) {
        const time = postingTimeUtc({ date: FRI, countries: [country], network });
        const local = localTimeString(time, COUNTRY_RULES[country].timezone);
        expect(local >= FRIDAY_PRAYER.start && local < FRIDAY_PRAYER.end, `${country} ${network} ${local}`).toBe(false);
      }
    }
  });

  it("moves a Friday time inside the prayer window to just after it, even an override", () => {
    const time = postingTimeUtc({ date: FRI, countries: ["PK"], network: "x", override: { x: "13:00" } });
    expect(localTimeString(time, "Asia/Karachi")).toBe(FRIDAY_PRAYER.end);
    // On other days the override is used as is.
    const monday = postingTimeUtc({ date: MON, countries: ["PK"], network: "x", override: { x: "13:00" } });
    expect(localTimeString(monday, "Asia/Karachi")).toBe("13:00");
  });

  it("shifts a Friday time in the window for Pakistan and a GCC country (UAE)", () => {
    for (const [country, tz] of [["PK", "Asia/Karachi"], ["AE", "Asia/Dubai"]] as const) {
      const time = postingTimeUtc({ date: FRI, countries: [country], network: "x", override: { x: "13:00" } });
      expect(localTimeString(time, tz), country).toBe(FRIDAY_PRAYER.end);
    }
  });

  it("does NOT shift Friday times in the UK or the US", () => {
    for (const [country, tz] of [["GB", "Europe/London"], ["US", "America/New_York"]] as const) {
      const time = postingTimeUtc({ date: FRI, countries: [country], network: "x", override: { x: "13:00" } });
      expect(localTimeString(time, tz), country).toBe("13:00");
    }
  });

  it("the brand's override wins when present (other networks keep the defaults)", () => {
    const override = { instagram: "07:15" };
    expect(localTimeString(postingTimeUtc({ date: MON, countries: ["PK"], network: "instagram", override }), "Asia/Karachi")).toBe("07:15");
    expect(localTimeString(postingTimeUtc({ date: MON, countries: ["PK"], network: "tiktok", override }), "Asia/Karachi")).not.toBe("07:15");
  });

  it("ignores a broken override instead of crashing", () => {
    const time = postingTimeUtc({ date: MON, countries: ["PK"], network: "instagram", override: { instagram: "25:99" } });
    expect(iso(time)).toBe("2026-12-07T15:00:00.000Z");
  });

  it("uses the first (primary) country when there are several", () => {
    const saFirst = postingTimeUtc({ date: FRI, countries: ["SA", "PK"], network: "instagram" });
    const saOnly = postingTimeUtc({ date: FRI, countries: ["SA"], network: "instagram" });
    expect(iso(saFirst)).toBe(iso(saOnly));
  });

  it("falls back to Pakistan when no country is given, and to a sensible default for unknown ones", () => {
    expect(iso(postingTimeUtc({ date: MON, countries: [], network: "instagram" }))).toBe("2026-12-07T15:00:00.000Z");
    const unknown = postingTimeUtc({ date: MON, countries: ["ZZ"], network: "instagram" });
    expect(localTimeString(unknown, "UTC")).toBe("19:00");
  });

  it("follows daylight saving time (United States)", () => {
    // 19:00 in New York: 23:00 UTC in summer, 00:00 UTC next day in winter.
    expect(iso(postingTimeUtc({ date: "2026-07-06", countries: ["US"], network: "instagram" }))).toBe("2026-07-06T23:00:00.000Z");
    expect(iso(postingTimeUtc({ date: "2026-12-07", countries: ["US"], network: "instagram" }))).toBe("2026-12-08T00:00:00.000Z");
  });
});

describe("Ramadan (dates from app_settings)", () => {
  const ramadan = { start: "2027-02-08", end: "2027-03-09" };

  it("knows which dates are in Ramadan (start and end included)", () => {
    expect(isRamadan("2027-02-08", ramadan)).toBe(true);
    expect(isRamadan("2027-03-09", ramadan)).toBe(true);
    expect(isRamadan("2027-02-07", ramadan)).toBe(false);
    expect(isRamadan("2027-03-10", ramadan)).toBe(false);
    expect(isRamadan("2027-02-20", null)).toBe(false);
    expect(isRamadan("2027-02-20", { start: null, end: null })).toBe(false);
  });

  it("shifts every network to after iftar / late evening (21:00 or later)", () => {
    for (const country of ["PK", "AE", "SA", "QA"]) {
      for (const network of NETWORKS) {
        const time = postingTimeUtc({ date: "2027-02-15", countries: [country], network, ramadan });
        const local = localTimeString(time, COUNTRY_RULES[country].timezone);
        expect(local >= "21:00", `${country} ${network} ${local}`).toBe(true);
      }
    }
  });

  it("uses normal times outside Ramadan", () => {
    const time = postingTimeUtc({ date: "2027-03-15", countries: ["PK"], network: "linkedin", ramadan });
    expect(localTimeString(time, "Asia/Karachi") < "21:00").toBe(true);
  });

  it("an override still wins during Ramadan", () => {
    const time = postingTimeUtc({ date: "2027-02-15", countries: ["PK"], network: "instagram", ramadan, override: { instagram: "23:30" } });
    expect(localTimeString(time, "Asia/Karachi")).toBe("23:30");
  });
});
