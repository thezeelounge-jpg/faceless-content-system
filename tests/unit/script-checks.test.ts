import { describe, expect, it } from "vitest";
import type { ScriptOutput, ScriptQaOutput } from "@/lib/ai-schemas";
import { SCRIPT_QA } from "@/lib/qa/config";
import {
  deterministicScriptIssues,
  findBannedWords,
  firstSentence,
  judgeScript,
  rubricScriptIssues,
} from "@/lib/qa/script-checks";

const SCRIPT: ScriptOutput = {
  hook: "Is your child's fever serious?",
  body: "Here is what to watch at home.",
  cta: "Book an online consultation today.",
  display_text: "Is your child's fever serious? Here is what to watch at home. Book an online consultation today.",
  captions: { instagram: "ig", tiktok: "tt", linkedin: "li", x: "x" },
  hashtags: ["#health", "#parents", "#fever"],
  broll_keywords: ["thermometer"],
  edit_plan: { broll_moments: [], emphasis_words: [] },
};

const OPTS = { bannedWords: ["miracle", "cure all"], wordsPerSecond: 2.4, maxSeconds: 45 };

const RUBRIC: ScriptQaOutput = {
  hook_ok: true,
  cta_matches_offers: true,
  no_made_up_facts: true,
  risky_claims_softened: true,
  language_matches: true,
  platform_safe: true,
  voice_score: 8,
  issues: [],
};

const codes = (issues: { code: string }[]) => issues.map((i) => i.code).sort();

describe("thresholds live in lib/qa/config.ts", () => {
  it("has the QA-SPEC starting values", () => {
    expect(SCRIPT_QA.hook_max_words).toBe(12);
    expect(SCRIPT_QA.voice_pass_score).toBe(7);
    expect(SCRIPT_QA.max_rewrites).toBe(1);
  });
});

describe("firstSentence", () => {
  it("stops at the first . ? or !", () => {
    expect(firstSentence("Is it serious? Here is why.")).toBe("Is it serious?");
    expect(firstSentence("No full stop at all")).toBe("No full stop at all");
  });

  it("does not stop after Dr., Mr. or Rs.", () => {
    expect(firstSentence("Dr. Ayesha says Rs. 500 is enough. Next.")).toBe("Dr. Ayesha says Rs. 500 is enough.");
  });
});

describe("findBannedWords (case-insensitive, whole word)", () => {
  it("finds whole words in any case", () => {
    expect(findBannedWords("A MIRACLE pill", ["miracle"])).toEqual(["miracle"]);
    expect(findBannedWords("This is a cure all, really", ["cure all"])).toEqual(["cure all"]);
  });

  it("ignores parts of other words and blank entries", () => {
    expect(findBannedWords("miracles happen, unmiracle", ["miracle"])).toEqual([]);
    expect(findBannedWords("anything", ["", "  "])).toEqual([]);
  });

  it("finds a banned word in a hashtag", () => {
    expect(findBannedWords("#miracle", ["miracle"])).toEqual(["miracle"]);
  });
});

describe("deterministic checks (our code)", () => {
  it("passes a good script", () => {
    expect(deterministicScriptIssues(SCRIPT, OPTS)).toEqual([]);
  });

  it("length: words ÷ words_per_second must be ≤ the plan's max seconds", () => {
    const long = `${SCRIPT.hook} ${"word ".repeat(120).trim()}. ${SCRIPT.cta}`;
    const issues = deterministicScriptIssues({ ...SCRIPT, display_text: long }, OPTS);
    expect(codes(issues)).toEqual(["length"]);
    expect(issues[0].severity).toBe("hard");
    // Exactly at the limit passes: 108 words ÷ 2.4 = 45 s.
    const exact = Array.from({ length: 108 }, () => "word").join(" ").replace(/^word/, "Why?");
    expect(deterministicScriptIssues({ ...SCRIPT, display_text: exact, cta: "word word" }, OPTS)).toEqual([]);
  });

  it("hook: the first sentence has 12 words or fewer", () => {
    const thirteen = "One two three four five six seven eight nine ten eleven twelve thirteen?";
    const issues = deterministicScriptIssues({ ...SCRIPT, display_text: `${thirteen} ${SCRIPT.cta}` }, OPTS);
    expect(codes(issues)).toEqual(["hook_length"]);
    const twelve = "One two three four five six seven eight nine ten eleven twelve?";
    expect(deterministicScriptIssues({ ...SCRIPT, display_text: `${twelve} ${SCRIPT.cta}` }, OPTS)).toEqual([]);
  });

  it("banned words: none in the text, captions or hashtags", () => {
    expect(codes(deterministicScriptIssues({ ...SCRIPT, display_text: `${SCRIPT.display_text} A Miracle.` }, OPTS))).toEqual([
      "banned_word",
    ]);
    expect(
      codes(deterministicScriptIssues({ ...SCRIPT, captions: { ...SCRIPT.captions, tiktok: "cure all" } }, OPTS)),
    ).toEqual(["banned_word"]);
    expect(codes(deterministicScriptIssues({ ...SCRIPT, hashtags: [...SCRIPT.hashtags, "#miracle"] }, OPTS))).toEqual([
      "banned_word",
    ]);
  });

  it("call to action: present and said at the end of the text", () => {
    expect(codes(deterministicScriptIssues({ ...SCRIPT, cta: " " }, OPTS))).toEqual(["cta_missing"]);
    expect(codes(deterministicScriptIssues({ ...SCRIPT, cta: "Follow for more." }, OPTS))).toEqual(["cta_missing"]);
  });
});

describe("Claude's rubric (hard checks fail, voice is soft)", () => {
  it("passes when every check is true", () => {
    expect(rubricScriptIssues(RUBRIC)).toEqual([]);
  });

  it.each([
    ["hook_ok", "hook"],
    ["cta_matches_offers", "cta"],
    ["no_made_up_facts", "made_up_fact"],
    ["risky_claims_softened", "risky_claim"],
    ["language_matches", "language"],
    ["platform_safe", "platform"],
  ] as const)("%s = false is a hard issue (%s)", (field, code) => {
    const issues = rubricScriptIssues({ ...RUBRIC, [field]: false });
    expect(issues).toEqual([expect.objectContaining({ code, severity: "hard", at_seconds: null })]);
  });

  it("keeps Claude's own detail for a failed check", () => {
    const issues = rubricScriptIssues({
      ...RUBRIC,
      no_made_up_facts: false,
      issues: [{ code: "made_up_fact", detail: 'Remove "9 out of 10 patients".' }],
    });
    expect(issues).toEqual([{ code: "made_up_fact", detail: 'Remove "9 out of 10 patients".', at_seconds: null, severity: "hard" }]);
  });

  it("voice below the pass score is a soft issue", () => {
    const issues = rubricScriptIssues({ ...RUBRIC, voice_score: SCRIPT_QA.voice_pass_score - 1 });
    expect(issues).toEqual([expect.objectContaining({ code: "voice", severity: "soft" })]);
    expect(rubricScriptIssues({ ...RUBRIC, voice_score: SCRIPT_QA.voice_pass_score })).toEqual([]);
  });

  it("notes for checks Claude marked as passed are soft", () => {
    const issues = rubricScriptIssues({ ...RUBRIC, issues: [{ code: "hook", detail: "Could be punchier." }] });
    expect(issues).toEqual([expect.objectContaining({ code: "hook", severity: "soft" })]);
  });
});

describe("judgeScript", () => {
  it("passes with score = voice score", () => {
    expect(judgeScript(SCRIPT, OPTS, RUBRIC)).toEqual({ passed: true, score: 8, issues: [] });
  });

  it("low voice alone does not fail the gate (soft), but is recorded", () => {
    const result = judgeScript(SCRIPT, OPTS, { ...RUBRIC, voice_score: 4 });
    expect(result.passed).toBe(true);
    expect(result.score).toBe(4);
    expect(codes(result.issues)).toEqual(["voice"]);
  });

  it("any hard issue fails the gate, ours or Claude's", () => {
    expect(judgeScript({ ...SCRIPT, cta: "" }, OPTS, RUBRIC).passed).toBe(false);
    expect(judgeScript(SCRIPT, OPTS, { ...RUBRIC, platform_safe: false }).passed).toBe(false);
  });
});
