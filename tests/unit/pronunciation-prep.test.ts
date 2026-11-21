import { beforeEach, describe, expect, it } from "vitest";
import { ClaudeError, runClaudeTask, type ClaudeContext, type ClaudeTaskName, type TaskOutput } from "@/lib/claude";
import { findRiskyWords } from "@/lib/pronunciation/risky-words";
import { runGate2, runScriptChecks, type QaBrand, type StoredScript } from "@/lib/qa/script-pipeline";
import { memoryStore, seedScript, type MemoryStore } from "../helpers/memory-store";

const BRAND: QaBrand = {
  id: "10000000-0000-0000-0000-000000000001",
  name: "Dr Ayesha Clinic",
  niche: "doctor",
  audience: "parents",
  offers: "Online consultation for Rs 2,999",
  tone: "Warm",
  sound_answers: {},
  samples: null,
  banned_words: [],
  language: "en",
  profile_md: null,
  pillars: [],
  words_per_second: 2.4,
  is_managed: true,
  autopilot_level: "review_everything",
};

const DISPLAY = "Is fever serious? I'm Dr Ayesha from Gulberg, near PKLI. Book your online consultation for Rs 2,999 today.";

function scriptRow(display = DISPLAY): Omit<StoredScript, "id" | "qa_status" | "spoken_text"> {
  return {
    post_id: "post-1",
    version: 1,
    est_seconds: 8,
    hook: "Is fever serious?",
    body: "I'm Dr Ayesha from Gulberg, near PKLI.",
    cta: "Book your online consultation for Rs 2,999 today.",
    display_text: display,
    captions: { instagram: "a", tiktok: "b", linkedin: "c", x: "d" },
    hashtags: ["#a", "#b", "#c"],
    broll_keywords: [],
    edit_plan: { broll_moments: [], emphasis_words: [] },
  };
}

function mockRunner() {
  const calls: { task: ClaudeTaskName; input: unknown }[] = [];
  const run = <T extends ClaudeTaskName>(task: T, ctx: ClaudeContext<T>): Promise<TaskOutput<T>> => {
    calls.push({ task, input: ctx.input });
    return runClaudeTask(task, ctx, { mock: true, logUsage: async () => {} });
  };
  return { run, calls };
}

let store: MemoryStore;
beforeEach(() => {
  store = memoryStore();
  store.pronunciations.push({ brand_id: BRAND.id!, written: "Ayesha", say_as: "aa-ye-sha", status: "approved", source: "manual" });
});

describe("findRiskyWords", () => {
  it("finds names in the middle of sentences, brand-name words and unknown acronyms", () => {
    expect(findRiskyWords(DISPLAY, { brandName: BRAND.name, known: [] })).toEqual(["Ayesha", "Gulberg", "PKLI"]);
    expect(findRiskyWords("Is it real? Book Zee Lounge now.", { brandName: "Zee Lounge", known: [] })).toEqual(["Zee", "Lounge"]);
  });

  it("skips words already in the dictionary (any status, any case), common acronyms and words said by rule", () => {
    expect(findRiskyWords("Meet Ayesha and the CEO of NASA today.", { brandName: "", known: ["ayesha"] })).toEqual([]);
    // Words of a multi-word entry count as known.
    expect(findRiskyWords("Come to Zee Lounge.", { brandName: "Zee Lounge", known: ["Zee Lounge"] })).toEqual([]);
  });

  it("skips sentence starts, days, months, titles, web addresses, handles and hashtags", () => {
    const text = "Lahore is busy. On Monday in December, Dr Ali posts at zeelounge.com, @ZeeLounge and #KarachiFood.";
    expect(findRiskyWords(text, { brandName: "", known: [] })).toEqual(["Ali"]);
  });

  it("keeps the first spelling once and caps the list", () => {
    const letter = (n: number) => String.fromCharCode(97 + n);
    const many = Array.from({ length: 30 }, (_, i) => `Zed${letter(i % 26)}${letter(Math.floor(i / 26))}`).join(" and ");
    expect(findRiskyWords(`Hi ${many}.`, { brandName: "", known: [] }).length).toBeLessThanOrEqual(10);
    expect(findRiskyWords("See Gulberg and gulberg and Gulberg.", { brandName: "", known: [] })).toEqual(["Gulberg"]);
  });
});

describe("Gate 2: pronunciation prep", () => {
  it("saves spoken_text (rupees in words, dictionary say-as) and keeps display_text", async () => {
    const script = await seedScript(store, { ...scriptRow(), qa_status: "passed" });
    const { run } = mockRunner();
    const result = await runGate2({ brand: BRAND, script, run, store });

    expect(result.passed).toBe(true);
    const saved = store.scripts[0];
    expect(saved.display_text).toBe(DISPLAY);
    expect(saved.spoken_text).toContain("two thousand nine hundred and ninety-nine rupees");
    expect(saved.spoken_text).toContain("Doctor aa-ye-sha");
    expect(saved.spoken_text).not.toMatch(/\d|Rs/);
  });

  it("asks Claude FAST only about unknown risky words and saves its answers as suggested (source qa), not applied", async () => {
    const script = await seedScript(store, { ...scriptRow(), qa_status: "passed" });
    const { run, calls } = mockRunner();
    await runGate2({ brand: BRAND, script, run, store });

    expect(calls).toEqual([{ task: "pronunciation_suggest", input: { words: ["Gulberg", "PKLI"] } }]);
    expect(store.pronunciations.filter((p) => p.status === "suggested")).toEqual([
      { brand_id: BRAND.id, written: "Gulberg", say_as: "gu-lb-er-g", status: "suggested", source: "qa" },
      { brand_id: BRAND.id, written: "PKLI", say_as: "P K L I", status: "suggested", source: "qa" },
    ]);
    // Suggested respellings are not used until approved.
    expect(store.scripts[0].spoken_text).toContain("Gulberg");
    expect(store.scripts[0].spoken_text).not.toContain("gu-lb-er-g");
  });

  it("writes one qa_reports row (gate pronunciation_prep) with the new words as soft notes", async () => {
    const script = await seedScript(store, { ...scriptRow(), qa_status: "passed" });
    const { run } = mockRunner();
    await runGate2({ brand: BRAND, script, run, store });
    expect(store.reports).toEqual([
      {
        script_id: script.id,
        gate: "pronunciation_prep",
        passed: true,
        score: null,
        auto_fix: null,
        issues: [
          expect.objectContaining({ code: "new_word", severity: "soft", detail: expect.stringContaining('"Gulberg"') }),
          expect.objectContaining({ code: "new_word", severity: "soft", detail: expect.stringContaining('"PKLI"') }),
        ],
      },
    ]);
  });

  it("makes no Claude call when every risky word is known", async () => {
    const script = await seedScript(store, { ...scriptRow("Is fever serious? Book for Rs 2,999."), qa_status: "passed" });
    const { run, calls } = mockRunner();
    const result = await runGate2({ brand: BRAND, script, run, store });
    expect(calls).toEqual([]);
    expect(result.passed).toBe(true);
    expect(store.reports[0].issues).toEqual([]);
  });

  it("a Claude error while suggesting is a soft note, not a failure", async () => {
    const script = await seedScript(store, { ...scriptRow(), qa_status: "passed" });
    const run = (async () => {
      throw new ClaudeError("busy", "Claude is busy right now. Try again in a few minutes.");
    }) as unknown as ReturnType<typeof mockRunner>["run"];
    const result = await runGate2({ brand: BRAND, script, run, store });
    expect(result.passed).toBe(true);
    expect(store.reports[0].issues).toEqual([expect.objectContaining({ code: "suggest_failed", severity: "soft" })]);
  });

  it("fails when spoken_text still has something a voice can't read", async () => {
    const script = await seedScript(store, { ...scriptRow("Is fever serious? Use code <SAVE> today."), qa_status: "passed" });
    const { run } = mockRunner();
    const result = await runGate2({ brand: BRAND, script, run, store });
    expect(result.passed).toBe(false);
    expect(store.reports[0]).toMatchObject({ gate: "pronunciation_prep", passed: false });
    expect(store.reports[0].issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "unspeakable", severity: "hard" })]));
  });
});

describe("both gates (runScriptChecks)", () => {
  it("Gate 1 pass → Gate 2 → post goes on; spoken_text saved on the passing version", async () => {
    const script = await seedScript(store, scriptRow());
    const { run } = mockRunner();
    const result = await runScriptChecks({ brand: BRAND, postId: "post-1", script, maxSeconds: 45, run, store });
    expect(result.outcome).toBe("script_review");
    expect(store.reports.map((r) => [r.gate, r.passed])).toEqual([
      ["script", true],
      ["pronunciation_prep", true],
    ]);
    expect(store.scripts[0]).toMatchObject({ qa_status: "passed", spoken_text: expect.stringContaining("rupees") });
    expect(store.posts.get("post-1")).toEqual({ status: "script_review", status_reason: null });
  });

  it("self-serve 'review videos only' brand goes straight to approved", async () => {
    const script = await seedScript(store, scriptRow());
    const { run } = mockRunner();
    const brand = { ...BRAND, is_managed: false, autopilot_level: "review_videos" };
    const result = await runScriptChecks({ brand, postId: "post-1", script, maxSeconds: 45, run, store });
    expect(result.outcome).toBe("approved");
    expect(store.posts.get("post-1")?.status).toBe("approved");
  });

  it("a passed script without spoken_text only runs Gate 2 (safe to re-run)", async () => {
    const script = await seedScript(store, { ...scriptRow(), qa_status: "passed" });
    const { run, calls } = mockRunner();
    await runScriptChecks({ brand: BRAND, postId: "post-1", script, maxSeconds: 45, run, store });
    expect(calls.map((c) => c.task)).not.toContain("script_qa");
    expect(store.reports.map((r) => r.gate)).toEqual(["pronunciation_prep"]);
  });

  it("a Gate 2 failure goes to the team queue for managed brands", async () => {
    const script = await seedScript(store, { ...scriptRow("Is fever serious? Use code <SAVE> for your online consultation for Rs 2,999 today."), cta: "your online consultation for Rs 2,999 today", qa_status: "passed" });
    const { run } = mockRunner();
    const result = await runScriptChecks({ brand: BRAND, postId: "post-1", script, maxSeconds: 45, run, store });
    expect(result.outcome).toBe("team_review");
    expect(store.scripts[0].qa_status).toBe("team_review");
    expect(store.posts.get("post-1")?.status_reason).toMatch(/^Pronunciation prep failed: unspeakable\.$/);
  });
});
