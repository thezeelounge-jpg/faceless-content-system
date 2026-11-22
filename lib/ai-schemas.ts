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

/**
 * Gate 3 key-term check (p5-a2): a key term the speech-to-text heard differently. Claude (FAST)
 * decides whether it is the same sound (a spelling variant, common in Roman Urdu / Hinglish) or a
 * real mispronunciation, and suggests a respelling for the voice when it is wrong.
 */
export const keyTermInput = z.object({
  /** brands.language: en | roman_urdu | hinglish. */
  language: z.string().min(2).max(20),
  terms: z
    .array(
      z.object({
        /** The term as written in the script (brand, name, offer, CTA word, dictionary word). */
        written: z.string().min(1).max(120),
        /** What speech-to-text heard there ("" = nothing). */
        heard: z.string().max(200),
      }),
    )
    .min(1)
    .max(30),
});

export const keyTermOutput = z.object({
  /** One per term, same order, `written` and `heard` copied exactly. */
  judgements: z.array(
    z.object({
      written: z.string().min(1),
      heard: z.string(),
      verdict: z.enum(["same_sound", "mispronounced"]),
      /** For "mispronounced": how the voice should be told to say it (letters and hyphens). "" for same_sound. */
      respelling: z.string(),
    }),
  ),
});

/** Consent clip face check: frames from the clip are sent as images. */
export const clipFaceInput = z.object({
  clip_name: z.string().min(1).max(300),
  frame_count: z.number().int().min(1).max(10),
});

export const clipFaceOutput = z.object({
  /** One entry per frame, in the order sent. */
  frames: z
    .array(
      z.object({
        /** How many human faces are visible in the frame. */
        faces: z.number().int().min(0).max(20),
        /** The main face is sharp, well lit, facing the camera and not covered. */
        face_clear: z.boolean(),
      }),
    )
    .min(1)
    .max(10),
});

/**
 * Gate 5 (p5-b2): visual and realism QA. Frames sampled from the final reel go in as images (in the
 * order of `frames`), each with the caption line on screen when it was taken.
 */
export const VISUAL_QA_FIELDS = [
  "face_natural",
  "mouth_area_clean",
  "hands_ok",
  "background_stable",
  "captions_readable",
  "captions_clear_of_face",
  "broll_matches_line",
  "no_stray_text",
  "first_frame_strong",
] as const;

export const visualQaInput = z.object({
  /** brands.language: en | roman_urdu | hinglish. */
  language: z.string().min(2).max(20),
  /** What the viewer reads (scripts.display_text). Also picks the MOCK_CLAUDE fixture. */
  display_text: z.string().min(1).max(5000),
  /** The caption style burned in (lib/captions.ts). */
  caption_style: z.enum(["big_words", "small_box", "minimal"]),
  frames: z
    .array(
      z.object({
        /** 0-based, the same order as the images. */
        index: z.number().int().min(0),
        at_seconds: z.number().min(0),
        kind: z.enum(["first", "every_2s", "broll", "last"]),
        /** The caption line on screen at that moment ("" = none). */
        caption: z.string().max(500),
      }),
    )
    .min(1)
    .max(40),
});

/** A box in pixels of the full 1080x1920 frame (top < bottom, left < right). */
const frameBox = z.object({ top: z.number(), bottom: z.number(), left: z.number(), right: z.number() });

export const visualQaOutput = z.object({
  face_natural: z.boolean(),
  mouth_area_clean: z.boolean(),
  hands_ok: z.boolean(),
  background_stable: z.boolean(),
  captions_readable: z.boolean(),
  captions_clear_of_face: z.boolean(),
  broll_matches_line: z.boolean(),
  no_stray_text: z.boolean(),
  first_frame_strong: z.boolean(),
  /** 1 to 10: would a viewer believe this is a real recording? */
  realism_score: z.number().int().min(1).max(10),
  /** The face over the talking-head frames (its LOWEST position: chin = bottom), or null if no face. */
  face_box: frameBox.nullable(),
  /** The mouth over the talking-head frames, or null. */
  mouth_box: frameBox.nullable(),
  /** One per problem: which field it breaks, the frame index where it shows, and a short plain detail. */
  issues: z.array(z.object({ field: z.enum([...VISUAL_QA_FIELDS, "realism_score"]), frame: z.number().int().min(0), detail: z.string().min(1).max(500) })),
});

export type VisualQaInput = z.infer<typeof visualQaInput>;
export type VisualQaOutput = z.infer<typeof visualQaOutput>;
export type ClipFaceOutput = z.infer<typeof clipFaceOutput>;
export type BrandProfileOutput = z.infer<typeof brandProfileOutput>;
export type PlanOutput = z.infer<typeof planOutput>;
export type ScriptOutput = z.infer<typeof scriptOutput>;
export type ScriptQaOutput = z.infer<typeof scriptQaOutput>;
export type PronunciationOutput = z.infer<typeof pronunciationOutput>;
export type KeyTermOutput = z.infer<typeof keyTermOutput>;
