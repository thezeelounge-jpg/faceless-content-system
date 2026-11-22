import { beforeEach, describe, expect, it } from "vitest";
import { runClaudeTask, type ClaudeContext, type ClaudeTaskName, type TaskOutput } from "@/lib/claude";
import type { MockScenario } from "@/lib/claude-mocks";
import { PlainError } from "@/lib/plain-error";
import { canOfferRewriteAnyway, OVERRIDE_HAS_VIDEO, OVERRIDE_NOT_NEEDED, rewriteScriptAnyway } from "@/lib/qa/script-override";
import { SCRIPT_REWRITE_CLOSED, runScriptChecks, type QaBrand, type StoredScript } from "@/lib/qa/script-pipeline";
import { scriptVersionResult } from "@/lib/qa/store";
import { writeScriptForPost } from "@/lib/scripts";
import { memoryStore, seedScript, type MemoryStore } from "../helpers/memory-store";

// p5-a: no script rewrite once the post has left scripting (planned / scripting), except an
// audited admin override. The database rule is insert_script_version (migration
// 20261122210000, tests/db/rls.test.ts); the memory store mirrors it.

const BRAND: QaBrand = {
  id: "10000000-0000-0000-0000-000000000001",
  name: "Dr Ayesha Clinic",
  niche: "doctor",
  audience: "Busy parents in Lahore",
  offers: "Online consultation for Rs 2,999",
  tone: "Warm",
  sound_answers: {},
  samples: null,
  banned_words: ["miracle"],
  language: "en",
  profile_md: "Profile",
  pillars: [],
  words_per_second: 2.4,
  is_managed: true,
  autopilot_level: "review_everything",
};
const POST = { id: "20000000-0000-0000-0000-000000000001", title: "Fever: when to worry", hook: "When is a fever serious?", pillar: "Fever myths", format: "talking" as const };
const MAX = 45;

function mockRunner(scenario: MockScenario) {
  const calls: ClaudeTaskName[] = [];
  const run = <T extends ClaudeTaskName>(task: T, ctx: ClaudeContext<T>): Promise<TaskOutput<T>> => {
    calls.push(task);
    return runClaudeTask(task, ctx, { mock: true, mockScenario: scenario, logUsage: async () => {} });
  };
  return { run, calls };
}

async function draft(store: MemoryStore, scenario: MockScenario): Promise<StoredScript> {
  const { run } = mockRunner(scenario);
  const row = await writeScriptForPost({ brand: BRAND, post: POST, maxSeconds: MAX, runScript: (ctx) => run("script", ctx) });
  return seedScript(store, row);
}

let store: MemoryStore;
beforeEach(() => {
  store = memoryStore();
});

describe("Gate 1's rewrite after the post left scripting", () => {
  it("refused with a plain error: no version 2, version 1 is not marked failed, the post is untouched", async () => {
    const v1 = await draft(store, "bad_first_draft");
    store.posts.set(POST.id, { status: "approved", status_reason: null }); // another run passed it meanwhile (Q8)
    const { run } = mockRunner("bad_first_draft");
    const attempt = runScriptChecks({ brand: BRAND, postId: POST.id, script: v1, maxSeconds: MAX, run, store });
    await expect(attempt).rejects.toThrow(SCRIPT_REWRITE_CLOSED);
    await expect(attempt).rejects.toBeInstanceOf(PlainError);
    expect(store.scripts.map((s) => [s.version, s.qa_status])).toEqual([[1, "pending"]]);
    expect(store.posts.get(POST.id)).toEqual({ status: "approved", status_reason: null });
    expect(store.audits).toEqual([]);
    expect(SCRIPT_REWRITE_CLOSED).toBe("This post has moved past scripting, so its script can't be rewritten. An admin can use “Rewrite anyway”.");
  });

  it("allowed while the post is still scripting", async () => {
    const v1 = await draft(store, "bad_first_draft");
    store.posts.set(POST.id, { status: "scripting", status_reason: null });
    const { run } = mockRunner("bad_first_draft");
    await runScriptChecks({ brand: BRAND, postId: POST.id, script: v1, maxSeconds: MAX, run, store });
    expect(store.scripts.map((s) => s.version)).toEqual([1, 2]);
    expect(store.audits).toEqual([]);
  });
});

describe("scriptVersionResult (the insert_script_version answer from Supabase)", () => {
  it("maps inserted/overridden to the id, closed/has_video to plain refusals, anything else to an error", () => {
    expect(scriptVersionResult({ outcome: "inserted", script_id: "s1" })).toBe("s1");
    expect(scriptVersionResult({ outcome: "overridden", script_id: "s2" })).toBe("s2");
    expect(() => scriptVersionResult({ outcome: "closed", script_id: null })).toThrow(SCRIPT_REWRITE_CLOSED);
    expect(() => scriptVersionResult({ outcome: "has_video", script_id: null })).toThrow(OVERRIDE_HAS_VIDEO);
    expect(() => scriptVersionResult({ outcome: "not_found", script_id: null })).toThrow("Post not found.");
    expect(() => scriptVersionResult({ outcome: "weird" })).toThrow(/unexpected answer/);
  });
});

describe("rewriteScriptAnyway (admin override)", () => {
  it("rewrites the latest version, records one audit row, puts the post back to scripting, then runs the checks", async () => {
    const v2 = await draft(store, "good");
    store.scripts[0].version = 2;
    store.scripts[0].qa_status = "team_review";
    store.posts.set(POST.id, { status: "team_review", status_reason: "Script QA failed after one rewrite: cta." });
    const { run, calls } = mockRunner("good");
    const result = await rewriteScriptAnyway({
      brand: BRAND, postId: POST.id, postStatus: "team_review", script: v2, adminEmail: "admin@example.com",
      reason: "Client asked for a softer ending", maxSeconds: MAX, run, store,
    });
    expect(calls[0]).toBe("script_rewrite");
    expect(store.scripts.map((s) => s.version)).toEqual([2, 3]);
    expect(result.script.version).toBe(3);
    expect(result.outcome).toBe("script_review"); // passed both gates → managed brand → script review
    expect(store.audits).toEqual([
      { scriptId: result.script.id, postId: POST.id, wasStatus: "team_review", by: "admin@example.com", reason: "Client asked for a softer ending" },
    ]);
    expect(store.posts.get(POST.id)?.status).toBe("script_review");
  });

  it("not needed (and refused) while the post is still being scripted", async () => {
    const v1 = await draft(store, "good");
    const { run, calls } = mockRunner("good");
    await expect(
      rewriteScriptAnyway({ brand: BRAND, postId: POST.id, postStatus: "scripting", script: v1, adminEmail: "a@x.com", reason: "Again please", maxSeconds: MAX, run, store }),
    ).rejects.toThrow(OVERRIDE_NOT_NEEDED);
    expect(calls).toEqual([]); // no Claude spend
    expect(store.audits).toEqual([]);
  });

  it("refused while the post has an active video (no new version, no audit)", async () => {
    const v1 = await draft(store, "good");
    store.posts.set(POST.id, { status: "rendering", status_reason: null });
    store.postsWithActiveVideo.add(POST.id);
    const { run } = mockRunner("good");
    await expect(
      rewriteScriptAnyway({ brand: BRAND, postId: POST.id, postStatus: "rendering", script: v1, adminEmail: "a@x.com", reason: "Again please", maxSeconds: MAX, run, store }),
    ).rejects.toThrow(OVERRIDE_HAS_VIDEO);
    expect(store.scripts).toHaveLength(1);
    expect(store.audits).toEqual([]);
  });

  it("p5-b1 (QA SF3 + Rowan 5): a team_review post with an active video is refused BEFORE Claude: zero Claude calls", async () => {
    const v1 = await draft(store, "good");
    store.posts.set(POST.id, { status: "team_review", status_reason: "Audio check failed" });
    store.postsWithActiveVideo.add(POST.id);
    const { run, calls } = mockRunner("good");
    await expect(
      rewriteScriptAnyway({ brand: BRAND, postId: POST.id, postStatus: "team_review", script: v1, adminEmail: "a@x.com", reason: "Again please", maxSeconds: MAX, run, store }),
    ).rejects.toThrow(OVERRIDE_HAS_VIDEO);
    expect(calls).toEqual([]);
    expect(store.scripts).toHaveLength(1);
    expect(store.audits).toEqual([]);
  });

  it("p5-b1 (Rowan 5): the post's status is read from the database, not trusted from the page (scripting now → refused, no Claude)", async () => {
    const v1 = await draft(store, "good");
    store.posts.set(POST.id, { status: "scripting", status_reason: null }); // moved back meanwhile
    const { run, calls } = mockRunner("good");
    await expect(
      rewriteScriptAnyway({ brand: BRAND, postId: POST.id, postStatus: "team_review", script: v1, adminEmail: "a@x.com", reason: "Again please", maxSeconds: MAX, run, store }),
    ).rejects.toThrow(OVERRIDE_NOT_NEEDED);
    expect(calls).toEqual([]);
  });
});

describe("p5-b1 (Rowan 5): Gate 1's rewrite asks the cheap question first", () => {
  it("a post that left scripting: the rubric runs, but NO script_rewrite call is made", async () => {
    const v1 = await draft(store, "bad_first_draft");
    store.posts.set(POST.id, { status: "approved", status_reason: null });
    const { run, calls } = mockRunner("bad_first_draft");
    await expect(runScriptChecks({ brand: BRAND, postId: POST.id, script: v1, maxSeconds: MAX, run, store })).rejects.toThrow(SCRIPT_REWRITE_CLOSED);
    expect(calls).not.toContain("script_rewrite");
    expect(store.scripts.map((s) => [s.version, s.qa_status])).toEqual([[1, "pending"]]);
  });
});

describe("p5-b1 (QA SF3): where the Rewrite anyway button is offered", () => {
  const vid = (status: string, kind = "post") => ({ status, kind });
  it("script_review / needs_you with no active video only; never team_review; never with an active post video", () => {
    expect(canOfferRewriteAnyway({ status: "script_review", videos: [] })).toBe(true);
    expect(canOfferRewriteAnyway({ status: "needs_you" })).toBe(true);
    expect(canOfferRewriteAnyway({ status: "team_review", videos: [] })).toBe(false);
    expect(canOfferRewriteAnyway({ status: "scripting", videos: [] })).toBe(false);
    expect(canOfferRewriteAnyway({ status: "script_review", videos: [vid("queued")] })).toBe(false);
    expect(canOfferRewriteAnyway({ status: "needs_you", videos: [vid("final_qa")] })).toBe(false);
    // Failed / skipped videos and likeness tests are not active post videos (same rule as the database).
    expect(canOfferRewriteAnyway({ status: "script_review", videos: [vid("failed"), vid("skipped"), vid("rendering", "likeness_test")] })).toBe(true);
  });
});
