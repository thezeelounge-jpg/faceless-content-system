import { existsSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import script from "@/tests/fixtures/stt/sample-script.json";
import fixture from "@/tests/fixtures/stt/sample-transcript.json";
import { alignWords } from "@/lib/captions";
import { BROLL_NOT_SET_UP, getBrollProvider, mockBrollProvider, planBroll, type TimedWord } from "@/lib/broll";
import { BROLL } from "@/lib/qa/config";
import type { Transcript } from "@/lib/stt";

// lib/broll.ts: the provider (MOCK_PEXELS: local fixture clips only; no real
// client exists in this phase) and the planner (pure: where cut-ins go).

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Words spaced evenly: each word lasts `wordS`, then a `gapS` pause. */
function timed(text: string, startS = 0, wordS = 0.35, gapS = 0.05): TimedWord[] {
  let t = startS;
  return text.split(/\s+/).filter(Boolean).map((w) => {
    const word = { text: w, start_s: Math.round(t * 1000) / 1000, end_s: Math.round((t + wordS) * 1000) / 1000 };
    t += wordS + gapS;
    return word;
  });
}

const HOOK = "Stop scrolling right now because this changes everything.";
const BODY =
  "Most cafe owners never post on WhatsApp. They wait for walk-ins and hope. " +
  "But regulars love a quick message about the daily special. " +
  "Send one photo of fresh bread every morning and watch the tables fill. " +
  "Keep a simple list of loyal customers and greet them by name. " +
  "Small habits beat big ad budgets every single week of the year.";
const CTA = "Book a free call today and we will set it up.";
const TEXT = `${HOOK} ${BODY} ${CTA}`;
const WORDS = timed(TEXT); // 0.4 s a word
const DURATION = WORDS.at(-1)!.end_s + 0.5;
const HOOK_END = WORDS[HOOK.split(" ").length - 1].end_s;
const CTA_START = WORDS[WORDS.length - CTA.split(" ").length].start_s;
const MOMENTS = [
  { at_words: "post on WhatsApp", keyword: "phone" },
  { at_words: "daily special", keyword: "coffee shop" },
  { at_words: "fresh bread", keyword: "cafe" },
  { at_words: "loyal customers", keyword: "business" },
  { at_words: "big ad budgets", keyword: "city" },
];
const base = { words: WORDS, moments: MOMENTS, format: "story" as const, durationS: DURATION, hook: HOOK, cta: CTA };

const coverage = (cuts: { duration_s: number }[]) => cuts.reduce((s, c) => s + c.duration_s, 0);
const EPS = 1e-6;

describe("planBroll", () => {
  it("finds the hook end and the CTA start in the aligned words", () => {
    const plan = planBroll(base);
    expect(plan.protected).toEqual({ hook_end_s: HOOK_END, cta_start_s: CTA_START });
  });

  it("never covers the hook (start → end of its last word) or the CTA (first word → end of the video)", () => {
    for (const format of ["talking", "story"] as const) {
      const plan = planBroll({ ...base, format });
      expect(plan.cuts.length).toBeGreaterThan(0);
      for (const c of plan.cuts) {
        expect(c.start_s).toBeGreaterThanOrEqual(HOOK_END - EPS);
        expect(c.start_s + c.duration_s).toBeLessThanOrEqual(CTA_START + EPS);
      }
    }
  });

  it("a moment inside the hook or the CTA is skipped as protected", () => {
    const plan = planBroll({
      ...base,
      moments: [{ at_words: "changes everything", keyword: "city" }, { at_words: "free call", keyword: "phone" }],
      keywords: [],
    });
    expect(plan.cuts).toEqual([]);
    expect(plan.skipped.map((s) => s.why)).toEqual(["protected", "protected"]);
  });

  it("places each cut at its at_words moment (start of the first matched word)", () => {
    const plan = planBroll(base);
    const at = plan.cuts.find((c) => c.at_words === "post on WhatsApp")!;
    const first = WORDS.findIndex((w, i) => w.text === "post" && WORDS[i + 1].text === "on");
    expect(at.start_s).toBe(WORDS[first].start_s);
    expect(at.keyword).toBe("phone");
  });

  it("matches at_words in the normal form (case, punctuation, '3' = 'three')", () => {
    const words = timed("Stop now. Here are 3 tips that really work for busy owners. Grow your café, friends, with these tricks every day. Book today.");
    const plan = planBroll({
      words, moments: [{ at_words: "THREE TIPS", keyword: "x" }, { at_words: "your cafe", keyword: "y" }],
      format: "story", durationS: 10, hook: "Stop now.", cta: "Book today.",
    });
    expect(plan.skipped.filter((s) => s.why === "not_found")).toEqual([]);
    expect(plan.cuts.map((c) => c.at_words)).toEqual(["THREE TIPS", "your cafe"]);
  });

  it("every cut lasts 1.5 to 3 s", () => {
    for (const format of ["talking", "story"] as const) {
      const { cuts } = planBroll({ ...base, format });
      expect(cuts.length).toBeGreaterThanOrEqual(2);
      for (const c of cuts) {
        expect(c.duration_s).toBeGreaterThanOrEqual(BROLL.min_cut_s - EPS);
        expect(c.duration_s).toBeLessThanOrEqual(BROLL.max_cut_s + EPS);
      }
    }
  });

  it("coverage caps per format: talking ≤ 25%, story ≤ 60% of the video", () => {
    const talking = planBroll({ ...base, format: "talking" });
    const story = planBroll({ ...base, format: "story" });
    expect(coverage(talking.cuts)).toBeLessThanOrEqual(0.25 * DURATION + EPS);
    expect(coverage(story.cuts)).toBeLessThanOrEqual(0.6 * DURATION + EPS);
    // Times are kept in whole milliseconds.
    expect(Math.abs(talking.max_coverage_s - 0.25 * DURATION)).toBeLessThanOrEqual(0.0005 + EPS);
    expect(Math.abs(story.max_coverage_s - 0.6 * DURATION)).toBeLessThanOrEqual(0.0005 + EPS);
    expect(talking.coverage_s).toBe(coverage(talking.cuts));
    // A short talking reel: the cap allows one short cut at most.
    const short = planBroll({ ...base, format: "talking", durationS: 8 });
    expect(coverage(short.cuts)).toBeLessThanOrEqual(2 + EPS);
  });

  it("coverage cap shortens the last cut, then drops what no longer fits", () => {
    // 10 s talking reel → 2.5 s of b-roll in total.
    const words = timed("Hook here now. One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen. Bye now.");
    const plan = planBroll({
      words, durationS: 10, format: "talking", hook: "Hook here now.", cta: "Bye now.",
      moments: [{ at_words: "one two", keyword: "a" }, { at_words: "nine ten", keyword: "b" }], keywords: [],
    });
    expect(coverage(plan.cuts)).toBeLessThanOrEqual(2.5 + EPS);
    expect(plan.cuts).toHaveLength(1);
    expect(plan.skipped).toEqual([{ at_words: "nine ten", why: "coverage" }]);
  });

  it("2 to 4 cuts when they fit: at most 4 even with 5 moments", () => {
    const plan = planBroll(base);
    expect(plan.cuts.length).toBeGreaterThanOrEqual(BROLL.min_cuts);
    expect(plan.cuts.length).toBeLessThanOrEqual(BROLL.max_cuts);
    expect(plan.cuts).toHaveLength(4);
    expect(plan.skipped).toContainEqual({ at_words: "big ad budgets", why: "max_cuts" });
  });

  it("only one moment → a second cut is added in the biggest free gap, from broll_keywords", () => {
    const plan = planBroll({ ...base, moments: [MOMENTS[1]], keywords: ["coffee", "phone"] });
    expect(plan.cuts).toHaveLength(2);
    const fill = plan.cuts.find((c) => c.at_words === null)!;
    expect(fill.keyword).toBe("coffee");
    expect(fill.duration_s).toBeGreaterThanOrEqual(BROLL.min_cut_s);
  });

  it("no moments and no keywords → no b-roll (nothing to search for)", () => {
    expect(planBroll({ ...base, moments: [], keywords: [] }).cuts).toEqual([]);
  });

  it("cuts never overlap, are in time order, and leave the face on screen between them", () => {
    // Two moments right next to each other: one gives way so the face shows between cuts.
    const plan = planBroll({
      ...base,
      moments: [{ at_words: "Most cafe owners", keyword: "cafe" }, { at_words: "never post", keyword: "phone" }, ...MOMENTS.slice(1)],
    });
    expect(plan.cuts.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < plan.cuts.length; i += 1) {
      const prev = plan.cuts[i - 1];
      expect(plan.cuts[i].start_s).toBeGreaterThanOrEqual(prev.start_s + prev.duration_s + BROLL.min_gap_s - EPS);
    }
  });

  it("a moment too close to the previous cut (no room for 1.5 s + gap) is dropped as overlap", () => {
    const plan = planBroll({
      ...base,
      moments: [{ at_words: "Most cafe", keyword: "cafe" }, { at_words: "cafe owners", keyword: "phone" }],
      keywords: [],
    });
    expect(plan.cuts).toHaveLength(1);
    expect(plan.skipped).toEqual([{ at_words: "cafe owners", why: "overlap" }]);
  });

  it("the previous cut is shortened only when the next one then really fits (else it keeps its length)", () => {
    // 0.4 s a word: "Alpha" 0.8 s (cut 0.8 → 3.3), "eta" 3.2 s, the CTA ("Bye") 4.0 s.
    // Shortening Alpha to make room would work (1.9 s), but eta has only 0.8 s before the CTA.
    const words = timed("Hook now. Alpha beta gamma delta epsilon zeta eta theta. Bye bye now.");
    const plan = planBroll({
      words, durationS: words.at(-1)!.end_s, format: "story", hook: "Hook now.", cta: "Bye bye now.", keywords: [],
      moments: [{ at_words: "Alpha", keyword: "a" }, { at_words: "eta", keyword: "b" }],
    });
    expect(plan.cuts).toEqual([{ start_s: 0.8, duration_s: 2.5, keyword: "a", at_words: "Alpha" }]);
    expect(plan.skipped).toEqual([{ at_words: "eta", why: "no_room" }]);
  });

  it("unknown at_words are skipped (not_found), the rest still placed", () => {
    const plan = planBroll({ ...base, moments: [{ at_words: "purple elephants", keyword: "x" }, MOMENTS[2]], keywords: [] });
    expect(plan.skipped).toEqual([{ at_words: "purple elephants", why: "not_found" }]);
    expect(plan.cuts.map((c) => c.at_words)).toEqual(["fresh bread"]);
  });

  it("a cut near the CTA is shortened to end before it; too little room → no_room", () => {
    // 0.4 s a word: "epsilon" starts at 2.4 s, "theta" at 3.6 s, the CTA ("Bye") at 4.0 s.
    const words = timed("Hook now. Alpha beta gamma delta epsilon zeta eta theta. Bye bye now.");
    const input = { words, durationS: words.at(-1)!.end_s, format: "story" as const, hook: "Hook now.", cta: "Bye bye now.", keywords: [] };
    const shortened = planBroll({ ...input, moments: [{ at_words: "epsilon zeta", keyword: "a" }] });
    expect(shortened.cuts).toEqual([{ start_s: 2.4, duration_s: 1.6, keyword: "a", at_words: "epsilon zeta" }]);
    const tooLate = planBroll({ ...input, moments: [{ at_words: "theta", keyword: "b" }] });
    expect(tooLate.cuts).toEqual([]);
    expect(tooLate.skipped).toEqual([{ at_words: "theta", why: "no_room" }]);
  });

  it("hook or CTA not found in the words → no b-roll at all (the face stays on screen)", () => {
    expect(planBroll({ ...base, hook: "Totally different opening line." }).cuts).toEqual([]);
    expect(planBroll({ ...base, cta: "Follow for more." }).cuts).toEqual([]);
    const lost = planBroll({ ...base, hook: "Totally different opening line." });
    expect(lost.protected).toBeNull();
    // Every moment is reported (the whole video counts as protected), so the team can see why.
    expect(lost.skipped).toEqual(MOMENTS.map((m) => ({ at_words: m.at_words, why: "protected" })));
  });

  it("works on the real aligned words of the mock transcript (the cut is at 'grow your café')", () => {
    const words = alignWords(script.display_text, fixture as Transcript);
    const plan = planBroll({
      words, moments: script.edit_plan.broll_moments, format: "talking", durationS: fixture.duration_s,
      hook: "Stop scrolling!", cta: "Book a free call today.",
    });
    expect(plan.protected).toEqual({ hook_end_s: 0.98, cta_start_s: 4.4 });
    expect(plan.cuts[0]).toMatchObject({ start_s: 2.72, at_words: "grow your café", keyword: "coffee shop" });
    expect(plan.cuts[0].duration_s).toBe(1.5); // 25% of 6 s
  });
});

describe("B-roll provider", () => {
  it("mock (MOCK_PEXELS default): local fixture clips for a keyword, portrait and long enough", async () => {
    const clips = await getBrollProvider().search("coffee shop", { orientation: "portrait", minDuration_s: 3 });
    expect(clips.map((c) => c.id)).toEqual(["cafe-green", "cafe-blue"]);
    for (const c of clips) {
      expect(path.isAbsolute(c.file)).toBe(true);
      expect(existsSync(c.file)).toBe(true);
      expect(c.height).toBeGreaterThan(c.width);
      expect(c.duration_s).toBeGreaterThanOrEqual(3);
      expect(c.source).toBe("mock");
    }
  });

  it("mock: minDuration filters clips; a word inside the keyword matches; unknown keywords use the default list", async () => {
    const p = mockBrollProvider();
    expect((await p.search("coffee shop", { orientation: "portrait", minDuration_s: 3.4 })).map((c) => c.id)).toEqual(["cafe-green"]);
    expect((await p.search("WhatsApp chat", { orientation: "portrait", minDuration_s: 1.5 })).map((c) => c.id)).toEqual(["phone-magenta"]);
    expect((await p.search("purple elephants", { orientation: "portrait", minDuration_s: 1.5 }))[0].id).toBe("city-orange");
  });

  it("mock with no catalogue (e.g. a deployed task without tests/fixtures) → the same plain 'not set up yet' error", async () => {
    const empty = mkdtempSync(path.join(os.tmpdir(), "no-broll-"));
    await expect(mockBrollProvider(empty).search("coffee", { orientation: "portrait", minDuration_s: 1.5 })).rejects.toThrow(BROLL_NOT_SET_UP);
  });

  it("MOCK_PEXELS=false: a plain 'not set up yet' error and never a network call", async () => {
    vi.stubEnv("MOCK_PEXELS", "false");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(getBrollProvider().search("coffee", { orientation: "portrait", minDuration_s: 1.5 })).rejects.toThrow(BROLL_NOT_SET_UP);
    expect(BROLL_NOT_SET_UP).toBe("B-roll search is not set up yet.");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
