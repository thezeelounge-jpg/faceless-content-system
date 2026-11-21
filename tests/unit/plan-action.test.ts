import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { weekdayOf } from "@/lib/posting-times";

const BRAND_ID = "10000000-0000-0000-0000-000000000001";
const BRAND = {
  id: BRAND_ID,
  owner_id: "owner-1",
  name: "Coach Sana",
  niche: "coach",
  audience: "New team leads",
  offers: "Leadership sprint",
  tone: "Calm",
  sound_answers: {},
  samples: null,
  banned_words: [],
  language: "en",
  pillars: [
    { name: "Mindset shifts", description: "How new leads think." },
    { name: "Client wins", description: "Stories from clients." },
  ],
  posting_days: [1, 3, 5],
  posts_per_week: 3,
  audience_countries: ["PK"],
  posting_times_override: null,
  profile_md: "Profile",
  words_per_second: 2.4,
  current_version: 1,
};

const requireAdmin = vi.fn();
const getBrand = vi.fn();
const insertPosts = vi.fn(async (_rows: unknown[]) => {});
const loadPlanSettings = vi.fn(async () => ({ ramadan: null }));
const lastPlannedDate = vi.fn(async (_id: string, _tz: string) => null as string | null);
const runClaudeTask = vi.fn();

vi.mock("@/lib/auth", () => ({ requireAdmin: () => requireAdmin() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/brands", () => ({ getBrand: (id: string) => getBrand(id) }));
vi.mock("@/lib/posts", () => ({
  insertPosts: (rows: unknown[]) => insertPosts(rows),
  loadPlanSettings: () => loadPlanSettings(),
  lastPlannedDate: (id: string, tz: string) => lastPlannedDate(id, tz),
}));
vi.mock("@/lib/claude", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/claude")>();
  return { ...actual, runClaudeTask: (...args: unknown[]) => runClaudeTask(...args) };
});

const { planNextFourWeeks } = await import("@/app/admin/clients/[id]/actions");
const { runClaudeTask: realRun } = await vi.importActual<typeof import("@/lib/claude")>("@/lib/claude");

const idle = { status: "idle" as const, message: "" };

beforeEach(() => {
  requireAdmin.mockReset().mockResolvedValue({ id: "admin-1", email: "a@x.com", isAdmin: true });
  getBrand.mockReset().mockResolvedValue(BRAND);
  insertPosts.mockClear();
  lastPlannedDate.mockClear();
  runClaudeTask.mockReset().mockImplementation((task, ctx) => realRun(task, ctx, { mock: true, logUsage: async () => {} }));
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-12-06T10:00:00Z")); // Sunday in Karachi → plan starts Monday 7 Dec
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Plan next 4 weeks", () => {
  it("checks admin before anything else", async () => {
    requireAdmin.mockRejectedValue(new Error("NEXT_NOT_FOUND"));
    await expect(planNextFourWeeks(BRAND_ID, idle)).rejects.toThrow("NEXT_NOT_FOUND");
    expect(getBrand).not.toHaveBeenCalled();
    expect(runClaudeTask).not.toHaveBeenCalled();
    expect(insertPosts).not.toHaveBeenCalled();
  });

  it("inserts exactly posts_per_week planned posts per week on the chosen days, using PLANNER", async () => {
    const state = await planNextFourWeeks(BRAND_ID, idle);
    expect(state).toMatchObject({ status: "ok", message: "Planned 12 posts from 7 Dec to 1 Jan." });
    expect(runClaudeTask).toHaveBeenCalledTimes(1);
    expect(runClaudeTask.mock.calls[0][0]).toBe("plan");
    const rows = insertPosts.mock.calls[0][0] as { scheduled_for: string; status: string; brand_id: string }[];
    expect(rows).toHaveLength(12);
    for (const row of rows) {
      expect(row).toMatchObject({ status: "planned", brand_id: BRAND_ID });
      const localDate = new Date(new Date(row.scheduled_for).getTime() + 5 * 3600_000).toISOString().slice(0, 10);
      expect([1, 3, 5]).toContain(weekdayOf(localDate));
    }
  });

  it("starts after the last planned post", async () => {
    lastPlannedDate.mockResolvedValue("2026-12-20");
    await planNextFourWeeks(BRAND_ID, idle);
    expect(lastPlannedDate).toHaveBeenCalledWith(BRAND_ID, "Asia/Karachi");
    const rows = insertPosts.mock.calls[0][0] as { scheduled_for: string }[];
    expect(rows[0].scheduled_for >= "2026-12-21").toBe(true);
  });

  it("rejects a plan that doesn't match the slots and saves nothing", async () => {
    runClaudeTask.mockResolvedValue({
      posts: [{ date: "2026-12-07", pillar: "Mindset shifts", title: "Only one", hook: "Just one?", format: "talking" }],
    });
    const state = await planNextFourWeeks(BRAND_ID, idle);
    expect(state).toEqual({
      status: "error",
      message: "Claude's plan didn't match the chosen days. Nothing was saved. Please try again.",
    });
    expect(insertPosts).not.toHaveBeenCalled();
  });

  it("asks for the profile first when the brand has no pillars", async () => {
    getBrand.mockResolvedValue({ ...BRAND, pillars: [] });
    const state = await planNextFourWeeks(BRAND_ID, idle);
    expect(state.status).toBe("error");
    expect(state.message).toMatch(/profile first/);
    expect(runClaudeTask).not.toHaveBeenCalled();
    expect(insertPosts).not.toHaveBeenCalled();
  });

  it("shows a plain sentence when saving fails, and logs the details", async () => {
    insertPosts.mockRejectedValueOnce(new Error('insert into "posts" violates check constraint'));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const state = await planNextFourWeeks(BRAND_ID, idle);
    expect(state).toEqual({ status: "error", message: "Couldn't plan the next 4 weeks. Please try again in a minute." });
    expect(log).toHaveBeenCalledWith("[admin] plan failed", expect.objectContaining({ brandId: BRAND_ID }));
    log.mockRestore();
  });

  it("says so plainly when the client doesn't exist", async () => {
    getBrand.mockResolvedValue(null);
    expect(await planNextFourWeeks(BRAND_ID, idle)).toEqual({ status: "error", message: "Client not found." });
  });
});
