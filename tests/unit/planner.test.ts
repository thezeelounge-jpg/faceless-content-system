import { describe, expect, it } from "vitest";
import type { PlanOutput } from "@/lib/ai-schemas";
import {
  addDays,
  buildPlanSlots,
  createMonthlyPlan,
  matchPlanToSlots,
  PlanError,
  planNotes,
  planStartDate,
  type PlanSlot,
} from "@/lib/planner";
import { FRIDAY_PRAYER, localDateString, localTimeString, weekdayOf } from "@/lib/posting-times";
import { runClaudeTask, type ClaudeBrand } from "@/lib/claude";

const MON = "2026-12-07"; // a Monday
const THU = "2026-12-10"; // a Thursday
const NO_RAMADAN = { ramadan: null };

const brand = (over: Partial<{ posting_days: number[]; posts_per_week: number; audience_countries: string[]; posting_times_override: unknown }> = {}) => ({
  posting_days: [1, 3, 5],
  posts_per_week: 3,
  audience_countries: ["PK"],
  posting_times_override: null,
  ...over,
});

/** Slots grouped by 7-day window from the start date. */
function perWeek(slots: PlanSlot[], start: string): number[] {
  const counts = [0, 0, 0, 0];
  for (const slot of slots) {
    const days = (Date.parse(slot.date) - Date.parse(start)) / 86_400_000;
    counts[Math.floor(days / 7)] += 1;
  }
  return counts;
}

describe("plan slots (our code picks the days and times, not Claude)", () => {
  it("only uses the chosen days, exactly posts_per_week every week, for 4 weeks", () => {
    const slots = buildPlanSlots(brand(), MON, NO_RAMADAN);
    expect(slots).toHaveLength(12);
    expect(new Set(slots.map((s) => weekdayOf(s.date)))).toEqual(new Set([1, 3, 5]));
    expect(perWeek(slots, MON)).toEqual([3, 3, 3, 3]);
    expect(slots.map((s) => s.week)).toEqual([1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4]);
  });

  it("keeps the exact count when the plan starts mid-week", () => {
    const slots = buildPlanSlots(brand({ posting_days: [0, 2, 4], posts_per_week: 2 }), THU, NO_RAMADAN);
    expect(perWeek(slots, THU)).toEqual([2, 2, 2, 2]);
    expect(slots.every((s) => [0, 2, 4].includes(weekdayOf(s.date)))).toBe(true);
    expect(slots[0].date >= THU).toBe(true);
    expect(slots.at(-1)!.date <= addDays(THU, 27)).toBe(true);
  });

  it("puts at most 2 posts on one day, at two different times, in time order", () => {
    const slots = buildPlanSlots(brand({ posting_days: [1, 3, 5], posts_per_week: 5 }), MON, NO_RAMADAN);
    expect(perWeek(slots, MON)).toEqual([5, 5, 5, 5]);
    const byDay = new Map<string, string[]>();
    for (const s of slots) byDay.set(s.date, [...(byDay.get(s.date) ?? []), s.scheduled_for]);
    for (const times of byDay.values()) {
      expect(times.length).toBeLessThanOrEqual(2);
      expect(new Set(times).size).toBe(times.length);
      expect([...times].sort()).toEqual(times);
    }
    // Slots are in time order overall.
    expect(slots.map((s) => s.scheduled_for)).toEqual([...slots.map((s) => s.scheduled_for)].sort());
  });

  it("the 1st post of a day keeps the Instagram time, a 2nd one gets the LinkedIn time", () => {
    // Pakistan workday: Instagram 20:00, LinkedIn 10:00 (lib/posting-times.ts).
    const onMonday = (posts_per_week: number) =>
      buildPlanSlots(brand({ posting_days: [1], posts_per_week }), MON, NO_RAMADAN)
        .filter((s) => s.date === MON)
        .map((s) => localTimeString(new Date(s.scheduled_for), "Asia/Karachi"));
    expect(onMonday(1)).toEqual(["20:00"]); // a single post: Instagram time
    expect(onMonday(2)).toEqual(["10:00", "20:00"]); // two posts, in time order: LinkedIn slot, then Instagram slot
  });

  it("refuses more than 2 posts a day with a plain error", () => {
    expect(() => buildPlanSlots(brand({ posting_days: [1], posts_per_week: 3 }), MON, NO_RAMADAN)).toThrow(PlanError);
    expect(() => buildPlanSlots(brand({ posting_days: [], posts_per_week: 1 }), MON, NO_RAMADAN)).toThrow(/posting day/);
  });

  it("times come from lib/posting-times (UTC, matching the local date)", () => {
    const slots = buildPlanSlots(brand(), MON, NO_RAMADAN);
    expect(slots[0]).toMatchObject({ date: MON, scheduled_for: "2026-12-07T15:00:00.000Z" }); // 20:00 Karachi
    for (const s of slots) expect(localDateString(new Date(s.scheduled_for), "Asia/Karachi")).toBe(s.date);
  });

  it("never schedules inside the Friday prayer window", () => {
    for (const country of ["PK", "AE", "SA", "QA"]) {
      const slots = buildPlanSlots(
        brand({ posting_days: [5], posts_per_week: 2, audience_countries: [country], posting_times_override: { instagram: "13:00", linkedin: "12:45" } }),
        MON,
        NO_RAMADAN,
      );
      expect(slots).toHaveLength(8);
      for (const s of slots) {
        const tz = { PK: "Asia/Karachi", AE: "Asia/Dubai", SA: "Asia/Riyadh", QA: "Asia/Qatar" }[country]!;
        const local = localTimeString(new Date(s.scheduled_for), tz);
        expect(local >= FRIDAY_PRAYER.start && local < FRIDAY_PRAYER.end).toBe(false);
      }
    }
  });

  it("uses the country's weekend times (Friday is the weekend in Saudi Arabia)", () => {
    const sa = buildPlanSlots(brand({ posting_days: [5], posts_per_week: 1, audience_countries: ["SA"] }), MON, NO_RAMADAN);
    const pk = buildPlanSlots(brand({ posting_days: [5], posts_per_week: 1, audience_countries: ["PK"] }), MON, NO_RAMADAN);
    expect(localTimeString(new Date(sa[0].scheduled_for), "Asia/Riyadh")).toBe("21:30"); // SA weekend
    expect(localTimeString(new Date(pk[0].scheduled_for), "Asia/Karachi")).toBe("20:00"); // PK workday
  });

  it("moves Ramadan posts to the late evening and adds a Ramadan note for Claude", () => {
    const settings = { ramadan: { start: "2026-12-14", end: "2026-12-20" } };
    const slots = buildPlanSlots(brand({ posting_days: [1], posts_per_week: 1 }), MON, settings);
    const local = slots.map((s) => [s.date, localTimeString(new Date(s.scheduled_for), "Asia/Karachi")]);
    expect(local).toEqual([
      ["2026-12-07", "20:00"],
      ["2026-12-14", "21:30"],
      ["2026-12-21", "20:00"],
      ["2026-12-28", "20:00"],
    ]);
    expect(planNotes(slots, settings)).toMatch(/Ramadan/);
    expect(planNotes(slots, NO_RAMADAN)).toBeUndefined();
  });

  it("starts tomorrow, or the day after the last planned post", () => {
    expect(planStartDate("2026-12-07", null)).toBe("2026-12-08");
    expect(planStartDate("2026-12-07", "2026-12-01")).toBe("2026-12-08");
    expect(planStartDate("2026-12-07", "2026-12-20")).toBe("2026-12-21");
  });
});

describe("matching Claude's plan to the slots", () => {
  const slots = buildPlanSlots(brand({ posting_days: [1], posts_per_week: 1 }), MON, NO_RAMADAN);
  const pillars = ["Fever myths", "Clinic life"];
  const posts = (dates: string[], pillar = "fever myths"): PlanOutput => ({
    posts: dates.map((date) => ({ date, pillar, title: "A title", hook: "A hook?", format: "talking" as const })),
  });

  it("accepts a plan with the same dates in order, and uses the brand's pillar spelling", () => {
    const rows = matchPlanToSlots(slots, posts(slots.map((s) => s.date)), pillars);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({ scheduled_for: slots[0].scheduled_for, pillar: "Fever myths", format: "talking" });
  });

  it("rejects a wrong count, a wrong date or an unknown pillar with a plain error", () => {
    const dates = slots.map((s) => s.date);
    expect(() => matchPlanToSlots(slots, posts(dates.slice(1)), pillars)).toThrow(PlanError);
    expect(() => matchPlanToSlots(slots, posts([...dates.slice(0, 3), "2026-12-29"]), pillars)).toThrow(/didn't match/);
    expect(() => matchPlanToSlots(slots, posts(dates, "Crypto tips"), pillars)).toThrow(/pillar/);
  });
});

describe("createMonthlyPlan (mock Claude)", () => {
  const claudeBrand: ClaudeBrand & ReturnType<typeof brand> = {
    id: "10000000-0000-0000-0000-000000000001",
    name: "Dr Ayesha Clinic",
    niche: "doctor",
    audience: "Busy parents",
    offers: "Online consultation",
    tone: "Warm",
    sound_answers: {},
    samples: null,
    banned_words: [],
    language: "en",
    profile_md: "Profile",
    pillars: [
      { name: "Fever myths", description: "Common fever myths." },
      { name: "Clinic life", description: "Behind the scenes." },
    ],
    words_per_second: 2.4,
    ...brand({ posting_days: [1, 4], posts_per_week: 3 }),
  };

  it("returns planned posts for exactly the slots, using the PLANNER task", async () => {
    const tasks: string[] = [];
    const rows = await createMonthlyPlan({
      brand: claudeBrand,
      startDate: MON,
      settings: NO_RAMADAN,
      runPlan: (ctx) => {
        tasks.push("plan");
        return runClaudeTask("plan", ctx, { mock: true, logUsage: async () => {} });
      },
    });
    expect(tasks).toEqual(["plan"]);
    expect(rows).toHaveLength(12);
    expect(perWeek(rows.map((r) => ({ ...r, date: localDateString(new Date(r.scheduled_for), "Asia/Karachi"), week: 0 })), MON)).toEqual([3, 3, 3, 3]);
    for (const row of rows) {
      expect(row).toMatchObject({ brand_id: claudeBrand.id, status: "planned" });
      expect(["Fever myths", "Clinic life"]).toContain(row.pillar);
      expect(["talking", "story"]).toContain(row.format);
    }
  });

  it("needs pillars (from the brand profile) first", async () => {
    await expect(
      createMonthlyPlan({ brand: { ...claudeBrand, pillars: [] }, startDate: MON, settings: NO_RAMADAN, runPlan: async () => ({ posts: [] }) }),
    ).rejects.toThrow(/profile/);
  });

  it("sends the Ramadan note to Claude when a slot falls in Ramadan", async () => {
    let notes: string | undefined;
    await createMonthlyPlan({
      brand: claudeBrand,
      startDate: MON,
      settings: { ramadan: { start: "2026-12-14", end: "2026-12-20" } },
      runPlan: (ctx) => {
        notes = ctx.input.notes;
        return runClaudeTask("plan", ctx, { mock: true, logUsage: async () => {} });
      },
    });
    expect(notes).toMatch(/Ramadan-friendly/);
  });
});
