import { beforeEach, describe, expect, it, vi } from "vitest";
import { PLANS } from "@/lib/plans";

const BRAND_ID = "10000000-0000-0000-0000-000000000001";
const POST_ID = "20000000-0000-0000-0000-000000000001";
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
  pillars: [{ name: "Mindset shifts", description: "How new leads think." }],
  posting_days: [1],
  posts_per_week: 1,
  audience_countries: ["PK"],
  posting_times_override: null,
  profile_md: "Profile",
  words_per_second: 2.4,
  current_version: 1,
};
const POST = {
  id: POST_ID,
  brand_id: BRAND_ID,
  scheduled_for: "2026-12-07T15:00:00Z",
  pillar: "Mindset shifts",
  title: "Stop doing everything yourself",
  hook: "Why do new leads burn out first?",
  format: "talking",
  status: "planned",
};

const requireAdmin = vi.fn();
const getBrand = vi.fn();
const getPost = vi.fn();
const getOwnerPlan = vi.fn(async (_ownerId: string) => null as string | null);
const saveFirstScript = vi.fn(async (_row: Record<string, unknown>) => {});
const runClaudeTask = vi.fn();

vi.mock("@/lib/auth", () => ({ requireAdmin: () => requireAdmin() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/brands", () => ({ getBrand: (id: string) => getBrand(id) }));
vi.mock("@/lib/posts", () => ({
  getPost: (id: string) => getPost(id),
  getOwnerPlan: (id: string) => getOwnerPlan(id),
  saveFirstScript: (row: Record<string, unknown>) => saveFirstScript(row),
}));
vi.mock("@/lib/claude", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/claude")>();
  return { ...actual, runClaudeTask: (...args: unknown[]) => runClaudeTask(...args) };
});

const { writeScript } = await import("@/app/admin/clients/[id]/actions");
const { runClaudeTask: realRun } = await vi.importActual<typeof import("@/lib/claude")>("@/lib/claude");

const idle = { status: "idle" as const, message: "" };

beforeEach(() => {
  requireAdmin.mockReset().mockResolvedValue({ id: "admin-1", email: "a@x.com", isAdmin: true });
  getBrand.mockReset().mockResolvedValue(BRAND);
  getPost.mockReset().mockResolvedValue(POST);
  getOwnerPlan.mockReset().mockResolvedValue(null);
  saveFirstScript.mockReset().mockResolvedValue(undefined);
  runClaudeTask.mockReset().mockImplementation((task, ctx) => realRun(task, ctx, { mock: true, logUsage: async () => {} }));
});

describe("Write script", () => {
  it("checks admin before anything else", async () => {
    requireAdmin.mockRejectedValue(new Error("NEXT_NOT_FOUND"));
    await expect(writeScript(POST_ID, idle)).rejects.toThrow("NEXT_NOT_FOUND");
    expect(getPost).not.toHaveBeenCalled();
    expect(runClaudeTask).not.toHaveBeenCalled();
    expect(saveFirstScript).not.toHaveBeenCalled();
  });

  it("writes with Claude MAIN and saves version 1, QA pending, within the Creator limit by default", async () => {
    const state = await writeScript(POST_ID, idle);
    expect(state.status).toBe("ok");
    expect(state.message).toMatch(/^Script written \(about \d+ seconds\)\.$/);
    expect(runClaudeTask.mock.calls[0][0]).toBe("script");
    expect(runClaudeTask.mock.calls[0][1].input.max_seconds).toBe(PLANS.creator.max_seconds_per_video);
    expect(getOwnerPlan).toHaveBeenCalledWith("owner-1");
    const row = saveFirstScript.mock.calls[0][0];
    expect(row).toMatchObject({ post_id: POST_ID, version: 1, qa_status: "pending" });
    expect(Number(row.est_seconds)).toBeLessThanOrEqual(PLANS.creator.max_seconds_per_video);
  });

  it("uses the owner's plan limit when there is one", async () => {
    getOwnerPlan.mockResolvedValue("pro");
    await writeScript(POST_ID, idle);
    expect(runClaudeTask.mock.calls[0][1].input.max_seconds).toBe(PLANS.pro.max_seconds_per_video);
  });

  it("rejects a too-long script with a plain sentence and saves nothing", async () => {
    const long = "word ".repeat(300).trim();
    runClaudeTask.mockResolvedValue({
      hook: "Hook?",
      body: long,
      cta: "Book now.",
      display_text: `Hook? ${long} Book now.`,
      captions: { instagram: "a", tiktok: "b", linkedin: "c", x: "d" },
      hashtags: ["#a", "#b", "#c"],
      broll_keywords: [],
      edit_plan: { broll_moments: [], emphasis_words: [] },
    });
    const state = await writeScript(POST_ID, idle);
    expect(state.status).toBe("error");
    expect(state.message).toMatch(/too long/);
    expect(saveFirstScript).not.toHaveBeenCalled();
  });

  it("only writes for planned posts", async () => {
    getPost.mockResolvedValue({ ...POST, status: "scripting" });
    const state = await writeScript(POST_ID, idle);
    expect(state).toEqual({ status: "error", message: "This post already has a script." });
    expect(runClaudeTask).not.toHaveBeenCalled();
  });

  it("says so plainly when the post doesn't exist", async () => {
    getPost.mockResolvedValue(null);
    expect(await writeScript(POST_ID, idle)).toEqual({ status: "error", message: "Post not found." });
  });

  it("hides database errors behind one plain sentence", async () => {
    saveFirstScript.mockRejectedValue(new Error('duplicate key value violates unique constraint "scripts_post_id_version_key"'));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const state = await writeScript(POST_ID, idle);
    expect(state).toEqual({ status: "error", message: "Couldn't write the script. Please try again in a minute." });
    expect(log).toHaveBeenCalledWith("[admin] write script failed", expect.objectContaining({ postId: POST_ID }));
    log.mockRestore();
  });
});
