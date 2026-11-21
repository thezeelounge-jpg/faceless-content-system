import { describe, expect, it } from "vitest";
import { scriptOutput, type ScriptOutput } from "@/lib/ai-schemas";
import { runClaudeTask, type ClaudeBrand } from "@/lib/claude";
import { PlainError } from "@/lib/plain-error";
import { PLANS } from "@/lib/plans";
import { countWords, estimateSeconds, maxSecondsFor, writeScriptForPost } from "@/lib/scripts";

const BRAND: ClaudeBrand = {
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
  pillars: [{ name: "Fever myths", description: "Common fever myths." }],
  words_per_second: 2.4,
};

const POST = {
  id: "20000000-0000-0000-0000-000000000001",
  title: "Fever: when to worry",
  hook: "Most parents wait too long to call a doctor.",
  pillar: "Fever myths",
  format: "talking" as const,
};

const mockRun = (ctx: Parameters<typeof runClaudeTask<"script">>[1]) =>
  runClaudeTask("script", ctx, { mock: true, logUsage: async () => {} });

describe("script schema (lib/ai-schemas.ts)", () => {
  const good: ScriptOutput = {
    hook: "Is your child's fever serious?",
    body: "Here is what to watch.",
    cta: "Book an online consultation.",
    display_text: "Is your child's fever serious? Here is what to watch. Book an online consultation.",
    captions: { instagram: "ig", tiktok: "tt", linkedin: "li", x: "x" },
    hashtags: ["#health", "#parents", "#fever"],
    broll_keywords: ["thermometer"],
    edit_plan: { broll_moments: [{ at_words: "what to watch", keyword: "thermometer" }], emphasis_words: ["fever"] },
  };

  it("accepts a full script", () => {
    expect(scriptOutput.safeParse(good).success).toBe(true);
  });

  it("needs all 4 captions, X under 280 characters, hashtags with #, and an edit plan", () => {
    const { x: _x, ...threeCaptions } = good.captions;
    expect(scriptOutput.safeParse({ ...good, captions: threeCaptions }).success).toBe(false);
    expect(scriptOutput.safeParse({ ...good, captions: { ...good.captions, x: "a".repeat(281) } }).success).toBe(false);
    expect(scriptOutput.safeParse({ ...good, hashtags: ["health", "#a", "#b"] }).success).toBe(false);
    const { edit_plan: _plan, ...noPlan } = good;
    expect(scriptOutput.safeParse(noPlan).success).toBe(false);
  });
});

describe("length (our code, not Claude)", () => {
  it("counts spoken words", () => {
    expect(countWords("  Hello there,  friend!\nHow are you? ")).toBe(6);
    expect(countWords("")).toBe(0);
  });

  it("est_seconds = words ÷ words_per_second, to 2 decimals", () => {
    expect(estimateSeconds("one two three four five six", 2.4)).toBe(2.5);
    expect(estimateSeconds("a b c", 2.4)).toBe(1.25);
    expect(estimateSeconds("a b c d e f g", 3)).toBe(2.33);
  });

  it("uses the brand owner's plan limit, Creator when there is no plan", () => {
    expect(maxSecondsFor(null)).toBe(PLANS.creator.max_seconds_per_video);
    expect(maxSecondsFor("pro")).toBe(PLANS.pro.max_seconds_per_video);
    expect(maxSecondsFor("agency")).toBe(60);
  });
});

describe("writeScriptForPost (mock Claude MAIN)", () => {
  it("returns every field, fits the plan's max seconds, and saves as version 1 with QA pending", async () => {
    for (const plan of [null, "pro"] as const) {
      const max = maxSecondsFor(plan);
      const row = await writeScriptForPost({ brand: BRAND, post: POST, maxSeconds: max, runScript: mockRun });
      expect(row).toMatchObject({ post_id: POST.id, version: 1, qa_status: "pending" });
      for (const key of ["display_text", "hook", "body", "cta", "captions", "hashtags", "broll_keywords", "edit_plan"]) {
        expect(row).toHaveProperty(key);
      }
      expect(Object.keys(row.captions).sort()).toEqual(["instagram", "linkedin", "tiktok", "x"]);
      expect(row.hashtags.length).toBeGreaterThanOrEqual(3);
      expect(row.est_seconds).toBe(estimateSeconds(row.display_text, BRAND.words_per_second));
      expect(row.est_seconds).toBeLessThanOrEqual(max);
      // Gate 2 (part B2) fills spoken_text later.
      expect(row).not.toHaveProperty("spoken_text");
    }
  });

  it("asks Claude for the plan's limit and the brand's speaking speed", async () => {
    let input: unknown;
    await writeScriptForPost({
      brand: BRAND,
      post: POST,
      maxSeconds: 45,
      runScript: (ctx) => {
        input = ctx.input;
        return mockRun(ctx);
      },
    });
    expect(input).toMatchObject({ title: POST.title, hook: POST.hook, max_seconds: 45, words_per_second: 2.4, format: "talking" });
  });

  it("rejects a script that is too long with a plain error (nothing to save)", async () => {
    const long = "word ".repeat(200).trim();
    await expect(
      writeScriptForPost({
        brand: BRAND,
        post: POST,
        maxSeconds: 45,
        runScript: async () => ({
          hook: "Hook?",
          body: long,
          cta: "Book now.",
          display_text: `Hook? ${long} Book now.`,
          captions: { instagram: "a", tiktok: "b", linkedin: "c", x: "d" },
          hashtags: ["#a", "#b", "#c"],
          broll_keywords: [],
          edit_plan: { broll_moments: [], emphasis_words: [] },
        }),
      }),
    ).rejects.toThrow(PlainError);
  });
});
