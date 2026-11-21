import { beforeEach, describe, expect, it } from "vitest";
import type { ScriptQaOutput } from "@/lib/ai-schemas";
import { runClaudeTask, type ClaudeContext, type ClaudeTaskName, type TaskOutput } from "@/lib/claude";
import type { MockScenario } from "@/lib/claude-mocks";
import { SCRIPT_QA } from "@/lib/qa/config";
import {
  postStatusAfterChecks,
  routeFailedScript,
  runGate1,
  runScriptChecks,
  type QaBrand,
  type StoredScript,
} from "@/lib/qa/script-pipeline";
import { writeScriptForPost } from "@/lib/scripts";
import { memoryStore, seedScript, type MemoryStore } from "../helpers/memory-store";

const BRAND: QaBrand = {
  id: "10000000-0000-0000-0000-000000000001",
  name: "Dr Ayesha Clinic",
  niche: "doctor",
  audience: "Busy parents in Lahore",
  offers: "Online consultation for Rs 2,999",
  tone: "Warm",
  sound_answers: { greeting: "Assalam o alaikum", phrases: "Seedhi baat", never_say: "Guaranteed" },
  samples: null,
  banned_words: ["miracle"],
  language: "en",
  profile_md: "Profile",
  pillars: [],
  words_per_second: 2.4,
  is_managed: true,
  autopilot_level: "review_everything",
};

const POST = {
  id: "20000000-0000-0000-0000-000000000001",
  title: "Fever: when to worry",
  hook: "When is a fever serious?",
  pillar: "Fever myths",
  format: "talking" as const,
};

const MAX = 45;

/** Mock Claude (no network, no cost) in the chosen scenario, counting calls per task. */
function mockRunner(scenario: MockScenario) {
  const calls: ClaudeTaskName[] = [];
  const run = <T extends ClaudeTaskName>(task: T, ctx: ClaudeContext<T>): Promise<TaskOutput<T>> => {
    calls.push(task);
    return runClaudeTask(task, ctx, { mock: true, mockScenario: scenario, logUsage: async () => {} });
  };
  return { run, calls };
}

async function firstDraft(store: MemoryStore, scenario: MockScenario): Promise<StoredScript> {
  const { run } = mockRunner(scenario);
  const row = await writeScriptForPost({ brand: BRAND, post: POST, maxSeconds: MAX, runScript: (ctx) => run("script", ctx) });
  return seedScript(store, row);
}

let store: MemoryStore;
beforeEach(() => {
  store = memoryStore();
});

describe("mock scenarios (so the rewrite path can be tested without spending)", () => {
  it("bad_first_draft writes a draft that fails our checks and Claude's rubric", async () => {
    const draft = await firstDraft(store, "bad_first_draft");
    const { run } = mockRunner("bad_first_draft");
    const result = await runGate1({ brand: BRAND, script: draft, maxSeconds: MAX, run, store });
    const codes = store.reports[0].issues.map((i) => i.code);
    // "Follow for more." is a call to action (so no cta_missing) but not one of the brand's offers (cta).
    expect(codes).toEqual(expect.arrayContaining(["hook_length", "banned_word", "cta", "made_up_fact"]));
    expect(codes).not.toContain("cta_missing");
    expect(result.passed).toBe(true);
  });
});

describe("Gate 1: pass path", () => {
  it("writes one passing qa_reports row (score = voice) and marks the script passed, no rewrite", async () => {
    const draft = await firstDraft(store, "good");
    const { run, calls } = mockRunner("good");
    const result = await runGate1({ brand: BRAND, script: draft, maxSeconds: MAX, run, store });

    expect(result.passed).toBe(true);
    expect(result.script.id).toBe(draft.id);
    expect(calls).toEqual(["script_qa"]);
    expect(store.reports).toEqual([
      { script_id: draft.id, gate: "script", passed: true, score: 8, issues: [], auto_fix: null },
    ]);
    expect(store.scripts).toHaveLength(1);
    expect(store.scripts[0].qa_status).toBe("passed");
  });
});

describe("Gate 1: fail → one rewrite → pass", () => {
  it("rewrites once with the listed issues, saves version 2, re-checks and passes", async () => {
    const draft = await firstDraft(store, "bad_first_draft");
    const { run, calls } = mockRunner("bad_first_draft");
    const result = await runGate1({ brand: BRAND, script: draft, maxSeconds: MAX, run, store });

    expect(calls).toEqual(["script_qa", "script_rewrite", "script_qa"]);
    expect(result.passed).toBe(true);
    expect(store.scripts.map((s) => [s.version, s.qa_status])).toEqual([
      [1, "failed"],
      [2, "passed"],
    ]);
    const v2 = store.scripts[1];
    expect(result.script.id).toBe(v2.id);
    expect(v2.post_id).toBe(POST.id);
    expect(v2.est_seconds).toBeLessThanOrEqual(MAX);
    expect(v2.display_text).not.toMatch(/miracle/i);

    expect(store.reports).toHaveLength(2);
    expect(store.reports[0]).toMatchObject({ script_id: draft.id, gate: "script", passed: false, auto_fix: null });
    expect(store.reports[0].issues.length).toBeGreaterThan(0);
    expect(store.reports[1]).toMatchObject({ script_id: v2.id, gate: "script", passed: true });
    expect(store.reports[1].auto_fix).toMatch(/^Rewrote once \(version 2\) to fix: /);
  });

  it("a Claude-only hard fail (language) also triggers the rewrite", async () => {
    const draft = await firstDraft(store, "good");
    const { run: mock } = mockRunner("good");
    let qaCalls = 0;
    let rewriteIssues: unknown;
    const run = (async (task: ClaudeTaskName, ctx: ClaudeContext<ClaudeTaskName>) => {
      const answer = await mock(task, ctx as never);
      if (task === "script_qa" && qaCalls++ === 0) {
        return { ...(answer as ScriptQaOutput), language_matches: false, issues: [{ code: "language", detail: 'Use English for "Seedhi baat".' }] };
      }
      if (task === "script_rewrite") rewriteIssues = (ctx.input as { issues: unknown }).issues;
      return answer;
    }) as typeof mock;
    const result = await runGate1({ brand: BRAND, script: draft, maxSeconds: MAX, run, store });
    expect(result.passed).toBe(true);
    expect(rewriteIssues).toEqual([{ code: "language", detail: 'Use English for "Seedhi baat".' }]);
  });
});

describe("Gate 1: fail → rewrite → fail goes to the team queue, never a second rewrite", () => {
  it("managed brand: script and post go to team_review with a plain reason", async () => {
    const draft = await firstDraft(store, "always_bad");
    const { run, calls } = mockRunner("always_bad");
    const result = await runScriptChecks({ brand: BRAND, postId: POST.id, script: draft, maxSeconds: MAX, run, store });

    expect(result.outcome).toBe("team_review");
    expect(calls.filter((c) => c === "script_rewrite")).toHaveLength(SCRIPT_QA.max_rewrites);
    expect(store.reports.map((r) => r.passed)).toEqual([false, false]);
    expect(store.scripts.map((s) => s.qa_status)).toEqual(["failed", "team_review"]);
    const post = store.posts.get(POST.id)!;
    expect(post.status).toBe("team_review");
    expect(post.status_reason).toMatch(/^Script QA failed after one rewrite: /);
    // Gate 2 does not run on a failed script.
    expect(store.reports.some((r) => r.gate === "pronunciation_prep")).toBe(false);
    expect(store.scripts.every((s) => s.spoken_text === null)).toBe(true);
  });

  it("self-serve brand: post shows Needs you with a plain reason (no codes, no seconds)", async () => {
    const selfServe = { ...BRAND, is_managed: false };
    const draft = await firstDraft(store, "always_bad");
    const { run } = mockRunner("always_bad");
    const result = await runScriptChecks({ brand: selfServe, postId: POST.id, script: draft, maxSeconds: MAX, run, store });

    expect(result.outcome).toBe("needs_you");
    expect(store.scripts.map((s) => s.qa_status)).toEqual(["failed", "failed"]);
    const post = store.posts.get(POST.id)!;
    expect(post.status).toBe("needs_you");
    expect(post.status_reason).toMatch(/^We couldn't get this script right on our own/);
    expect(post.status_reason).not.toMatch(/_|second|credit|engine|QA/);
  });

  it("a pending version 2 (already a rewrite) is checked but never rewritten again", async () => {
    const v1 = await firstDraft(store, "always_bad");
    const v2 = await seedScript(store, { ...v1, version: 2 });
    const { run, calls } = mockRunner("always_bad");
    const result = await runGate1({ brand: BRAND, script: v2, maxSeconds: MAX, run, store });
    expect(result.passed).toBe(false);
    expect(calls).toEqual(["script_qa"]);
    expect(store.reports).toHaveLength(1);
  });
});

describe("where the post goes", () => {
  it("after passing: managed brands and 'review everything' wait for script review; others are approved", () => {
    expect(postStatusAfterChecks({ is_managed: true, autopilot_level: "full_autopilot" })).toBe("script_review");
    expect(postStatusAfterChecks({ is_managed: false, autopilot_level: "review_everything" })).toBe("script_review");
    expect(postStatusAfterChecks({ is_managed: false, autopilot_level: "review_videos" })).toBe("approved");
    expect(postStatusAfterChecks({ is_managed: false, autopilot_level: "full_autopilot" })).toBe("approved");
  });

  it("after failing twice: plain words for each problem", () => {
    const issues = [
      { code: "length", detail: "x", at_seconds: null, severity: "hard" as const },
      { code: "banned_word", detail: "x", at_seconds: null, severity: "hard" as const },
      { code: "voice", detail: "x", at_seconds: null, severity: "soft" as const },
    ];
    const self = routeFailedScript({ is_managed: false }, issues);
    expect(self).toEqual({
      qa_status: "failed",
      post_status: "needs_you",
      reason: "We couldn't get this script right on our own: it's too long, and it used a word you asked us to avoid. Please take a look.",
    });
    const managed = routeFailedScript({ is_managed: true }, issues);
    expect(managed.qa_status).toBe("team_review");
    expect(managed.post_status).toBe("team_review");
    expect(managed.reason).toBe("Script QA failed after one rewrite: length, banned_word.");
  });
});
