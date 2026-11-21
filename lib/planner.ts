// Monthly planner (docs/PRODUCT.md "Planning rules").
//
// Our code decides WHEN to post: the 4-week slot list, only on the brand's
// posting days, exactly posts_per_week in every 7-day window, at most 2 a day,
// with times from lib/posting-times.ts. Claude (PLANNER) only fills in WHAT
// (pillar, title, hook, format) for those exact slots, and we check its answer
// matches before anything is saved.
import type { PlanOutput } from "@/lib/ai-schemas";
import { MAX_POSTS_PER_DAY } from "@/lib/brand-input";
import type { ClaudeBrand, ClaudeContext } from "@/lib/claude";
import { PlainError } from "@/lib/plain-error";
import { isRamadan, postingTimeUtc, type Network, type RamadanDates } from "@/lib/posting-times";

export const PLAN_WEEKS = 4;

/** The 1st post of a day goes at the Instagram time, a 2nd one at the LinkedIn time. */
const SLOT_NETWORKS: Network[] = ["instagram", "linkedin"];

export type PlannerBrand = {
  posting_days: number[];
  posts_per_week: number;
  audience_countries: string[];
  posting_times_override?: unknown;
};

export type PlanSettings = { ramadan: RamadanDates | null };

export type PlanSlot = {
  /** Local calendar date in the primary country. */
  date: string;
  /** UTC timestamp (ISO) for posts.scheduled_for. */
  scheduled_for: string;
  /** 1 to 4. */
  week: number;
};

export type PlannedPostRow = {
  brand_id: string;
  scheduled_for: string;
  pillar: string;
  title: string;
  hook: string;
  format: "talking" | "story";
  status: "planned";
};

/** A plain-words problem with the plan. Safe to show in admin. */
export class PlanError extends PlainError {
  constructor(message: string) {
    super(message);
    this.name = "PlanError";
  }
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function weekday(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** The next plan starts tomorrow, or the day after the last planned post if that is later. */
export function planStartDate(today: string, lastPostDate: string | null): string {
  const tomorrow = addDays(today, 1);
  if (!lastPostDate) return tomorrow;
  const afterLast = addDays(lastPostDate, 1);
  return afterLast > tomorrow ? afterLast : tomorrow;
}

/** How many posts go on each of n posting days, spread evenly (sums to `posts`). */
function spread(posts: number, days: number): number[] {
  const base = Math.floor(posts / days);
  const extra = posts % days;
  return Array.from({ length: days }, (_, j) =>
    base + (Math.floor(((j + 1) * extra) / days) > Math.floor((j * extra) / days) ? 1 : 0),
  );
}

/** The 4-week slot list. Pure: same brand, start date and settings → same slots. */
export function buildPlanSlots(brand: PlannerBrand, startDate: string, settings: PlanSettings): PlanSlot[] {
  const days = [...new Set(brand.posting_days)].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  if (days.length === 0) throw new PlanError("Pick at least one posting day for this client first.");
  if (brand.posts_per_week < 1 || brand.posts_per_week > days.length * MAX_POSTS_PER_DAY) {
    throw new PlanError(`Pick more posting days, or fewer posts per week (${MAX_POSTS_PER_DAY} a day at most).`);
  }

  const slots: PlanSlot[] = [];
  for (let week = 0; week < PLAN_WEEKS; week++) {
    // Each chosen weekday appears exactly once in any 7-day window.
    const dates = Array.from({ length: 7 }, (_, i) => addDays(startDate, week * 7 + i)).filter((date) =>
      days.includes(weekday(date)),
    );
    const counts = spread(brand.posts_per_week, dates.length);
    dates.forEach((date, j) => {
      const used = new Set<number>();
      const times = SLOT_NETWORKS.slice(0, counts[j]).map((network) => {
        let time = postingTimeUtc({
          date,
          countries: brand.audience_countries,
          ramadan: settings.ramadan,
          override: brand.posting_times_override,
          network,
        }).getTime();
        while (used.has(time)) time += 60 * 60_000; // two posts never share a time
        used.add(time);
        return time;
      });
      for (const time of times.sort((a, b) => a - b)) {
        slots.push({ date, scheduled_for: new Date(time).toISOString(), week: week + 1 });
      }
    });
  }
  return slots;
}

/** Extra instructions for Claude (Ramadan). */
export function planNotes(slots: PlanSlot[], settings: PlanSettings): string | undefined {
  const inRamadan = slots.filter((slot) => isRamadan(slot.date, settings.ramadan)).map((slot) => slot.date);
  if (inRamadan.length === 0) return undefined;
  return (
    `Ramadan runs from ${settings.ramadan?.start} to ${settings.ramadan?.end}. ` +
    `For the posts on ${[...new Set(inRamadan)].join(", ")}, lean toward Ramadan-friendly topics ` +
    `(reflection, routines around fasting, family, giving, health while fasting) and keep the tone respectful.`
  );
}

const PLAN_MISMATCH = "Claude's plan didn't match the chosen days. Nothing was saved. Please try again.";

/** Checks Claude's posts line up with the slots (count, dates, known pillars) and builds the rows. */
export function matchPlanToSlots(
  slots: PlanSlot[],
  plan: PlanOutput,
  pillars: string[],
  brandId = "",
): PlannedPostRow[] {
  if (plan.posts.length !== slots.length) throw new PlanError(PLAN_MISMATCH);
  const byKey = new Map(pillars.map((name) => [name.trim().toLowerCase(), name]));
  return slots.map((slot, i) => {
    const post = plan.posts[i];
    if (post.date !== slot.date) throw new PlanError(PLAN_MISMATCH);
    const pillar = byKey.get(post.pillar.trim().toLowerCase());
    if (!pillar) throw new PlanError("Claude used a pillar this client doesn't have. Nothing was saved. Please try again.");
    return {
      brand_id: brandId,
      scheduled_for: slot.scheduled_for,
      pillar,
      title: post.title,
      hook: post.hook,
      format: post.format,
      status: "planned",
    };
  });
}

/** Pillar names from brands.pillars ([{ name, description }]). */
export function pillarNames(pillars: unknown): string[] {
  if (!Array.isArray(pillars)) return [];
  return pillars
    .map((p) => (p && typeof p === "object" ? (p as { name?: unknown }).name : null))
    .filter((name): name is string => typeof name === "string" && name.trim() !== "");
}

/** Builds the slots, asks Claude (PLANNER) to fill them, checks the answer. Saves nothing. */
export async function createMonthlyPlan(args: {
  brand: ClaudeBrand & PlannerBrand;
  startDate: string;
  settings: PlanSettings;
  runPlan: (ctx: ClaudeContext<"plan">) => Promise<PlanOutput>;
}): Promise<PlannedPostRow[]> {
  const pillars = pillarNames(args.brand.pillars);
  if (pillars.length === 0) throw new PlanError("Write the brand profile first. It sets the pillars the plan uses.");
  const slots = buildPlanSlots(args.brand, args.startDate, args.settings);
  const plan = await args.runPlan({
    brand: args.brand,
    input: { slots: slots.map((slot) => slot.date), pillars, notes: planNotes(slots, args.settings) },
  });
  return matchPlanToSlots(slots, plan, pillars, args.brand.id ?? "");
}
