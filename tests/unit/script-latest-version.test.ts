import { beforeEach, describe, expect, it } from "vitest";
import { runClaudeTask, type ClaudeContext, type ClaudeTaskName, type TaskOutput } from "@/lib/claude";
import type { MockScenario } from "@/lib/claude-mocks";
import { runScriptChecks, type QaBrand, type StoredScript } from "@/lib/qa/script-pipeline";
import { scriptChecksFinishResult } from "@/lib/qa/store";
import { writeScriptForPost } from "@/lib/scripts";
import { memoryStore, seedScript, type MemoryStore } from "../helpers/memory-store";

// p5-b1 (Rowan 7): the script checks move the post on only for the post's LATEST script version.
// If a newer version exists (another run's rewrite, or an admin's Rewrite anyway), the older run's
// verdict stays in qa_reports but does not approve / route the post and does not touch the newer
// row. The database rule is rpc finish_script_checks (migration 20261122230000, tests/db/rls.test.ts).

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

const runner = (scenario: MockScenario) =>
  <T extends ClaudeTaskName>(task: T, ctx: ClaudeContext<T>): Promise<TaskOutput<T>> =>
    runClaudeTask(task, ctx, { mock: true, mockScenario: scenario, logUsage: async () => {} });

async function draft(store: MemoryStore, scenario: MockScenario, version: number): Promise<StoredScript> {
  const row = await writeScriptForPost({ brand: BRAND, post: POST, maxSeconds: MAX, runScript: (ctx) => runner(scenario)("script", ctx) });
  return seedScript(store, { ...row, version });
}

let store: MemoryStore;
beforeEach(() => {
  store = memoryStore();
  store.posts.set(POST.id, { status: "scripting", status_reason: null });
});

describe("only the latest version moves the post", () => {
  it("v1 passes both gates while a newer v2 is pending: the post is NOT approved, v2 stays pending", async () => {
    const v1 = await draft(store, "good", 1);
    const v2 = await draft(store, "good", 2);
    const result = await runScriptChecks({ brand: BRAND, postId: POST.id, script: v1, maxSeconds: MAX, run: runner("good"), store });
    expect(result.outcome).toBe("superseded");
    expect(store.posts.get(POST.id)).toEqual({ status: "scripting", status_reason: null });
    expect(store.scripts.find((s) => s.id === v2.id)?.qa_status).toBe("pending");
    // The verdict on v1 is still recorded.
    expect(store.reports.filter((r) => r.script_id === v1.id).map((r) => [r.gate, r.passed])).toEqual([
      ["script", true],
      ["pronunciation_prep", true],
    ]);
  });

  it("v2 fails (no rewrite left) while a newer v3 exists: the post is NOT sent to the team, v3 untouched", async () => {
    const v2 = await draft(store, "bad_first_draft", 2);
    const v3 = await draft(store, "good", 3);
    const result = await runScriptChecks({ brand: BRAND, postId: POST.id, script: v2, maxSeconds: MAX, run: runner("bad_first_draft"), store });
    expect(result.outcome).toBe("superseded");
    expect(store.posts.get(POST.id)).toEqual({ status: "scripting", status_reason: null });
    expect(store.scripts.find((s) => s.id === v3.id)?.qa_status).toBe("pending");
  });

  it("the latest version still moves the post as before", async () => {
    await draft(store, "good", 1);
    const v2 = await draft(store, "good", 2);
    const result = await runScriptChecks({ brand: BRAND, postId: POST.id, script: v2, maxSeconds: MAX, run: runner("good"), store });
    expect(result.outcome).toBe("script_review");
    expect(store.posts.get(POST.id)?.status).toBe("script_review");
    expect(store.scripts.find((s) => s.id === v2.id)?.qa_status).toBe("passed");
  });
});

describe("scriptChecksFinishResult (the finish_script_checks answer from Supabase)", () => {
  it("maps done / stale / moved_on / not_found; anything else is an error", () => {
    expect(scriptChecksFinishResult({ outcome: "done" })).toBe("done");
    expect(scriptChecksFinishResult({ outcome: "stale" })).toBe("stale");
    expect(scriptChecksFinishResult({ outcome: "moved_on" })).toBe("moved_on");
    expect(scriptChecksFinishResult({ outcome: "not_found" })).toBe("not_found");
    expect(() => scriptChecksFinishResult({ outcome: "weird" })).toThrow(/unexpected answer/);
  });
});
