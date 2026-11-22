import { beforeEach, describe, expect, it, vi } from "vitest";
import { PLANS } from "@/lib/plans";
import { memoryStore, type MemoryStore } from "../helpers/memory-store";

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
  is_managed: true,
  autopilot_level: "review_everything",
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
const saveFirstScript = vi.fn(async (_row: Record<string, unknown>): Promise<string> => "");
const getScriptForChecks = vi.fn();
const savePostProblem = vi.fn(async (_postId: string, _reason: string) => {});
const runClaudeTask = vi.fn();
let store: MemoryStore;

vi.mock("@/lib/auth", () => ({ requireAdmin: () => requireAdmin() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/brands", () => ({ getBrand: (id: string) => getBrand(id) }));
vi.mock("@/lib/posts", () => ({
  getPost: (id: string) => getPost(id),
  getOwnerPlan: (id: string) => getOwnerPlan(id),
  saveFirstScript: (row: Record<string, unknown>) => saveFirstScript(row),
  getScriptForChecks: (id: string) => getScriptForChecks(id),
  savePostProblem: (id: string, reason: string) => savePostProblem(id, reason),
}));
vi.mock("@/lib/qa/store", () => ({ createQaStore: () => store }));
vi.mock("@/lib/claude", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/claude")>();
  return { ...actual, runClaudeTask: (...args: unknown[]) => runClaudeTask(...args) };
});

const { checkScript, rewriteAnyway, writeScript } = await import("@/app/admin/clients/[id]/actions");
const { runClaudeTask: realRun, ClaudeError } = await vi.importActual<typeof import("@/lib/claude")>("@/lib/claude");

const idle = { status: "idle" as const, message: "" };

beforeEach(() => {
  store = memoryStore();
  requireAdmin.mockReset().mockResolvedValue({ id: "admin-1", email: "a@x.com", isAdmin: true });
  getBrand.mockReset().mockResolvedValue(BRAND);
  getPost.mockReset().mockResolvedValue(POST);
  getOwnerPlan.mockReset().mockResolvedValue(null);
  saveFirstScript
    .mockReset()
    .mockImplementation(async (row) => store.insertScriptVersion({ ...row, spoken_text: null } as never));
  getScriptForChecks.mockReset().mockResolvedValue(null);
  savePostProblem.mockReset().mockResolvedValue(undefined);
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
    expect(state.message).toMatch(/^Script written \(about \d+ seconds\)\. Checked: ready for script review\.$/);
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

  it("runs Gate 1 and Gate 2 right after saving, and moves the post on", async () => {
    await writeScript(POST_ID, idle);
    expect(store.reports.map((r) => [r.gate, r.passed])).toEqual([
      ["script", true],
      ["pronunciation_prep", true],
    ]);
    expect(store.scripts[0].qa_status).toBe("passed");
    expect(store.scripts[0].spoken_text).toBeTruthy();
    expect(store.posts.get(POST_ID)).toEqual({ status: "script_review", status_reason: null });
  });

  it("keeps the script when the checks fail to run, and says to press Run checks", async () => {
    runClaudeTask.mockImplementation((task, ctx) =>
      task === "script_qa"
        ? Promise.reject(new ClaudeError("busy", "Claude is busy right now. Try again in a few minutes."))
        : realRun(task, ctx, { mock: true, logUsage: async () => {} }),
    );
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const state = await writeScript(POST_ID, idle);
    log.mockRestore();
    expect(state.status).toBe("error");
    expect(state.message).toBe(
      "Script written, but the checks didn't finish: Claude is busy right now. Try again in a few minutes. Press “Run checks” to try again.",
    );
    expect(store.scripts).toHaveLength(1);
    expect(store.scripts[0].qa_status).toBe("pending");
  });

  it("saves a plain reason on the post when the checks didn't finish (no provider text)", async () => {
    runClaudeTask.mockImplementation((task, ctx) =>
      task === "script_qa"
        ? Promise.reject(new ClaudeError("failed", "Claude call failed (400). See server logs.", { cause: new Error("invalid_request_error sk-ant-fake") }))
        : realRun(task, ctx, { mock: true, logUsage: async () => {} }),
    );
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await writeScript(POST_ID, idle);
    log.mockRestore();
    expect(savePostProblem).toHaveBeenCalledWith(
      POST_ID,
      "Script written, but the checks didn't finish. Press “Run checks” to try again.",
    );
  });

  it("saves a plain reason on the post when writing failed", async () => {
    runClaudeTask.mockRejectedValue(new ClaudeError("busy", "Claude is busy right now. Try again in a few minutes."));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await writeScript(POST_ID, idle);
    log.mockRestore();
    expect(savePostProblem).toHaveBeenCalledWith(POST_ID, "Couldn't write the script. Press “Write script” to try again.");
  });

  it("still answers plainly if saving the reason fails too", async () => {
    runClaudeTask.mockRejectedValue(new ClaudeError("busy", "Claude is busy right now. Try again in a few minutes."));
    savePostProblem.mockRejectedValue(new Error("db down"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const state = await writeScript(POST_ID, idle);
    log.mockRestore();
    expect(state).toEqual({ status: "error", message: "Claude is busy right now. Try again in a few minutes." });
  });

  it("a rewrite that throws leaves the script retryable, and Run checks then finishes it", async () => {
    const bad = (task: string, ctx: unknown) => realRun(task as never, ctx as never, { mock: true, mockScenario: "always_bad", logUsage: async () => {} });
    runClaudeTask.mockImplementation((task, ctx) =>
      task === "script_rewrite" ? Promise.reject(new ClaudeError("busy", "Claude is busy right now. Try again in a few minutes.")) : bad(task, ctx),
    );
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const first = await writeScript(POST_ID, idle);
    log.mockRestore();
    expect(first.message).toMatch(/Press “Run checks” to try again\.$/);
    expect(store.scripts.map((s) => s.qa_status)).toEqual(["pending"]);

    // The page shows "Run checks" for this post, and the action accepts it.
    runClaudeTask.mockImplementation(bad);
    getScriptForChecks.mockResolvedValue({ script: store.scripts[0], post: { ...POST, status: "scripting" }, versions: store.scripts });
    const retry = await checkScript(store.scripts[0].id, idle);
    expect(retry).toEqual({ status: "ok", message: "It failed the checks after one rewrite and is in the team queue." });
    expect(store.scripts.map((s) => s.qa_status)).toEqual(["failed", "team_review"]);
    expect(store.posts.get(POST_ID)?.status).toBe("team_review");
  });
});

describe("Run checks", () => {
  const pending = () => ({
    script: {
      id: "script-9",
      post_id: POST_ID,
      version: 1,
      est_seconds: 4,
      qa_status: "pending",
      spoken_text: null,
      hook: "Why do new leads burn out first?",
      body: "Hello. Ask for help early.",
      cta: "Book your leadership sprint today.",
      display_text: "Why do new leads burn out first? Hello. Ask for help early. Book your leadership sprint today.",
      captions: { instagram: "a", tiktok: "b", linkedin: "c", x: "d" },
      hashtags: ["#a", "#b", "#c"],
      broll_keywords: [],
      edit_plan: { broll_moments: [], emphasis_words: [] },
    },
    post: { ...POST, status: "scripting" },
  });
  const withVersions = (found: ReturnType<typeof pending>) => ({ ...found, versions: [found.script] });

  it("checks admin before anything else", async () => {
    requireAdmin.mockRejectedValue(new Error("NEXT_NOT_FOUND"));
    await expect(checkScript("script-9", idle)).rejects.toThrow("NEXT_NOT_FOUND");
    expect(getScriptForChecks).not.toHaveBeenCalled();
    expect(runClaudeTask).not.toHaveBeenCalled();
  });

  it("says so plainly when the script doesn't exist", async () => {
    expect(await checkScript("script-9", idle)).toEqual({ status: "error", message: "Script not found." });
  });

  it("runs the gates on a pending script", async () => {
    const found = pending();
    await store.insertScriptVersion(found.script as never);
    found.script.id = store.scripts[0].id;
    getScriptForChecks.mockResolvedValue(withVersions(found));
    const state = await checkScript(found.script.id, idle);
    expect(state).toEqual({ status: "ok", message: "Checked: ready for script review." });
    expect(store.reports.map((r) => r.gate)).toEqual(["script", "pronunciation_prep"]);
  });

  it("refuses a script that was already checked", async () => {
    const found = pending();
    const done = { ...found.script, qa_status: "passed", spoken_text: "x" };
    getScriptForChecks.mockResolvedValue({ ...found, script: done, versions: [done] });
    expect(await checkScript("script-9", idle)).toEqual({ status: "error", message: "This script has already been checked." });
    expect(runClaudeTask).not.toHaveBeenCalled();
  });

  it("uses the same rule as the page: refuses an older version when a newer one exists", async () => {
    const found = pending();
    const newer = { ...found.script, id: "script-10", version: 2 };
    getScriptForChecks.mockResolvedValue({ ...found, versions: [found.script, newer] });
    expect(await checkScript("script-9", idle)).toEqual({
      status: "error",
      message: "A newer version of this script exists, so refresh the page and check that one.",
    });
    expect(runClaudeTask).not.toHaveBeenCalled();
  });

  it("uses the same rule as the page: refuses once the post has moved on", async () => {
    const found = pending();
    getScriptForChecks.mockResolvedValue({ ...withVersions(found), post: { ...POST, status: "approved" } });
    expect(await checkScript("script-9", idle)).toEqual({ status: "error", message: "This script has already been checked." });
    expect(runClaudeTask).not.toHaveBeenCalled();
  });

  it("saves a plain reason on the post when the checks fail to run", async () => {
    const found = pending();
    await store.insertScriptVersion(found.script as never);
    found.script.id = store.scripts[0].id;
    getScriptForChecks.mockResolvedValue(withVersions(found));
    runClaudeTask.mockRejectedValue(new ClaudeError("busy", "Claude is busy right now. Try again in a few minutes."));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const state = await checkScript(found.script.id, idle);
    log.mockRestore();
    expect(state).toEqual({ status: "error", message: "Claude is busy right now. Try again in a few minutes." });
    expect(savePostProblem).toHaveBeenCalledWith(POST_ID, "The checks didn't finish. Press “Run checks” to try again.");
  });
});

// p5-a: "Rewrite anyway" (admin override of the no-rewrite-after-scripting rule).
describe("Rewrite anyway", () => {
  const form = (fields: Record<string, string>) => {
    const data = new FormData();
    for (const [k, v] of Object.entries(fields)) data.set(k, v);
    return data;
  };
  const inTeamQueue = async () => {
    const script = {
      post_id: POST_ID, version: 2, est_seconds: 4, qa_status: "team_review", spoken_text: null,
      hook: "Why do new leads burn out first?", body: "Hello. Ask for help early.", cta: "Book your leadership sprint today.",
      display_text: "Why do new leads burn out first? Hello. Ask for help early. Book your leadership sprint today.",
      captions: { instagram: "a", tiktok: "b", linkedin: "c", x: "d" }, hashtags: ["#a", "#b", "#c"], broll_keywords: [],
      edit_plan: { broll_moments: [], emphasis_words: [] },
    };
    const id = await store.insertScriptVersion(script as never);
    store.posts.set(POST_ID, { status: "team_review", status_reason: "Script QA failed after one rewrite: cta." });
    const stored = store.scripts.find((s) => s.id === id)!;
    getScriptForChecks.mockResolvedValue({ script: stored, post: { ...POST, status: "team_review" }, versions: [stored] });
    return stored;
  };
  const good = { reason: "Client wants a softer ending", confirm: "yes" };

  it("checks admin before anything else", async () => {
    requireAdmin.mockRejectedValue(new Error("NEXT_NOT_FOUND"));
    await expect(rewriteAnyway("script-9", idle, form(good))).rejects.toThrow("NEXT_NOT_FOUND");
    expect(getScriptForChecks).not.toHaveBeenCalled();
    expect(runClaudeTask).not.toHaveBeenCalled();
  });

  it("needs the confirm box and a reason (nothing saved, no Claude call)", async () => {
    const script = await inTeamQueue();
    expect(await rewriteAnyway(script.id, idle, form({ reason: "Client wants a softer ending" }))).toEqual({
      status: "error",
      message: "Tick the box to confirm.",
    });
    expect((await rewriteAnyway(script.id, idle, form({ reason: "x", confirm: "yes" }))).status).toBe("error");
    expect((await rewriteAnyway(script.id, idle, form({ reason: "Client wants a softer ending", confirm: "on" }))).status).toBe("error");
    expect(runClaudeTask).not.toHaveBeenCalled();
    expect(store.audits).toEqual([]);
  });

  it("rewrites, audits the admin's email and reason, and runs the checks", async () => {
    const script = await inTeamQueue();
    const state = await rewriteAnyway(script.id, idle, form(good));
    expect(state).toEqual({ status: "ok", message: "Rewritten (version 3). Checked: ready for script review." });
    expect(store.audits).toEqual([
      { scriptId: store.scripts[1].id, postId: POST_ID, wasStatus: "team_review", by: "a@x.com", reason: "Client wants a softer ending" },
    ]);
  });

  it("refuses an older version, and a post still being scripted", async () => {
    const script = await inTeamQueue();
    const newer = { ...script, id: "script-10", version: 3 };
    getScriptForChecks.mockResolvedValue({ script, post: { ...POST, status: "team_review" }, versions: [script, newer] });
    expect((await rewriteAnyway(script.id, idle, form(good))).message).toBe(
      "A newer version of this script exists, so refresh the page and check that one.",
    );
    getScriptForChecks.mockResolvedValue({ script, post: { ...POST, status: "scripting" }, versions: [script] });
    expect(await rewriteAnyway(script.id, idle, form(good))).toEqual({
      status: "error",
      message: "This post is still being scripted. Use “Run checks” instead.",
    });
    expect(runClaudeTask).not.toHaveBeenCalled();
  });
});
