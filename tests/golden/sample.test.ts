// Sample output (mock mode, part of `npm test`): golden brand #1 through the
// whole brain — script writer → Gate 1 → Gate 2 — saved as a readable JSON
// file so the owner can see one full script with its QA reports.
// If a prompt-independent change alters it on purpose, update with `npx vitest run -u`.
import { describe, expect, it } from "vitest";
import { runClaudeTask, type ClaudeContext, type ClaudeTaskName, type TaskOutput } from "@/lib/claude";
import { GOLDEN_BRANDS } from "./brands";
import { runGoldenBrand } from "./run-golden";

const mockRun = <T extends ClaudeTaskName>(task: T, ctx: ClaudeContext<T>): Promise<TaskOutput<T>> =>
  runClaudeTask(task, ctx, { mock: true, logUsage: async () => {} });

describe("golden set", () => {
  it("has 5 brands in mixed niches and English, Roman Urdu and Hinglish, each fully filled in", () => {
    expect(GOLDEN_BRANDS).toHaveLength(5);
    expect(new Set(GOLDEN_BRANDS.map((g) => g.brand.niche)).size).toBe(5);
    expect(new Set(GOLDEN_BRANDS.map((g) => g.brand.language))).toEqual(new Set(["en", "roman_urdu", "hinglish"]));
    for (const { brand, plan } of GOLDEN_BRANDS) {
      expect(brand.offers).toBeTruthy();
      expect(brand.samples).toBeTruthy();
      expect(brand.banned_words.length).toBeGreaterThan(0);
      expect(brand.words_per_second).toBeGreaterThan(0);
      expect(plan).toBeTruthy();
    }
  });
});

describe("sample script (golden brand #1, mock mode)", () => {
  it("has every field, passes both gates, and turns Rs 2,999 and a dictionary name into spoken words", async () => {
    const golden = GOLDEN_BRANDS[0];
    const { result, reports } = await runGoldenBrand(golden, mockRun);
    const script = result.script;

    expect(result.outcome).toBe("script_review");
    expect(script.display_text).toContain("Rs 2,999");
    expect(script.display_text).toContain("Ayesha");
    expect(script.spoken_text).toContain("two thousand nine hundred and ninety-nine rupees");
    expect(script.spoken_text).toContain("aa-ye-sha");
    expect(script.spoken_text).not.toContain("Rs 2,999");
    expect(Object.keys(script.captions).sort()).toEqual(["instagram", "linkedin", "tiktok", "x"]);
    expect(reports.map((r) => [r.gate, r.passed])).toEqual([
      ["script", true],
      ["pronunciation_prep", true],
    ]);

    const sample = {
      brand: golden.brand.name,
      post: golden.post.title,
      outcome: result.outcome,
      script: {
        version: script.version,
        qa_status: script.qa_status,
        display_text: script.display_text,
        spoken_text: script.spoken_text,
        hook: script.hook,
        body: script.body,
        cta: script.cta,
        est_seconds: script.est_seconds,
        captions: script.captions,
        hashtags: script.hashtags,
        broll_keywords: script.broll_keywords,
        edit_plan: script.edit_plan,
      },
      qa_reports: reports,
    };
    await expect(`${JSON.stringify(sample, null, 2)}\n`).toMatchFileSnapshot("./__snapshots__/sample-mock-script.json");
  });
});
