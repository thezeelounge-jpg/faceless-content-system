// The shape of every answer we ask Claude for. Claude's JSON is checked
// against these before we use it, in real mode and in mock mode.
import { z } from "zod";

export const pillarSchema = z.object({
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().min(10).max(300),
});

export const brandProfileOutput = z.object({
  profile_md: z.string().trim().min(200).max(8000),
  pillars: z.array(pillarSchema).min(4).max(6),
});

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");
const postFormat = z.enum(["talking", "story"]);

export const planInput = z.object({
  /** The exact dates to plan, already chosen by our code from posting days and posts per week. */
  slots: z.array(isoDate).min(1).max(60),
  pillars: z.array(z.string()).min(1),
  notes: z.string().optional(),
});

export const planOutput = z.object({
  posts: z
    .array(
      z.object({
        date: isoDate,
        pillar: z.string().min(1),
        title: z.string().trim().min(3).max(120),
        hook: z.string().trim().min(3).max(200),
        format: postFormat,
      }),
    )
    .min(1)
    .max(60),
});

export const scriptInput = z.object({
  title: z.string(),
  hook: z.string(),
  pillar: z.string(),
  format: postFormat,
  max_seconds: z.number().positive(),
  words_per_second: z.number().positive(),
});

export const captionsSchema = z.object({
  instagram: z.string().min(1).max(2200),
  tiktok: z.string().min(1).max(2200),
  linkedin: z.string().min(1).max(3000),
  x: z.string().min(1).max(280),
});

export const scriptOutput = z.object({
  hook: z.string().trim().min(1),
  body: z.string().trim().min(1),
  cta: z.string().trim().min(1),
  /** hook + body + cta, as the viewer reads it in captions. */
  display_text: z.string().trim().min(1),
  captions: captionsSchema,
  hashtags: z.array(z.string().regex(/^#\S+$/)).min(3).max(15),
  broll_keywords: z.array(z.string().min(1)).max(10),
  edit_plan: z.object({
    broll_moments: z.array(z.object({ at_words: z.string().min(1), keyword: z.string().min(1) })).max(10),
    emphasis_words: z.array(z.string().min(1)).max(15),
  }),
});

export const scriptQaInput = z.object({
  script: scriptOutput.pick({ hook: true, body: true, cta: true, display_text: true }),
  max_seconds: z.number().positive(),
});

export const scriptQaOutput = z.object({
  hook_ok: z.boolean(),
  cta_matches_offers: z.boolean(),
  no_made_up_facts: z.boolean(),
  risky_claims_softened: z.boolean(),
  language_matches: z.boolean(),
  platform_safe: z.boolean(),
  voice_score: z.number().int().min(1).max(10),
  issues: z.array(z.object({ code: z.string().min(1), detail: z.string().min(1) })),
});

export const scriptRewriteInput = z.object({
  script: scriptOutput,
  issues: z.array(z.object({ code: z.string(), detail: z.string() })).min(1),
  max_seconds: z.number().positive(),
  words_per_second: z.number().positive(),
});

export const pronunciationInput = z.object({
  words: z.array(z.string().min(1)).min(1).max(50),
});

export const pronunciationOutput = z.object({
  suggestions: z.array(z.object({ written: z.string().min(1), say_as: z.string().min(1) })),
});

export type BrandProfileOutput = z.infer<typeof brandProfileOutput>;
export type PlanOutput = z.infer<typeof planOutput>;
export type ScriptOutput = z.infer<typeof scriptOutput>;
export type ScriptQaOutput = z.infer<typeof scriptQaOutput>;
export type PronunciationOutput = z.infer<typeof pronunciationOutput>;
