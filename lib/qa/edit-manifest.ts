import { z } from "zod";
import { CAPTION_STYLE_NAMES } from "@/lib/captions";

// videos.edit_manifest (p5-a2): what the editor (lib/edit-flow.ts) actually built, saved with the
// final file. Gate 4 (lib/qa/technical-gate.ts) checks the edit against it: caption pages and word
// timings (vs the speech-to-text words), b-roll cuts and the protected hook/CTA, the music bed and
// its gain (the stem check re-runs the same chain), label and watermark. Server only.

const word = z.object({
  text: z.string(),
  start_s: z.number(),
  end_s: z.number(),
  source: z.enum(["matched", "substituted", "merged", "split", "interpolated"]),
  stt_indexes: z.array(z.number().int().min(0)),
});

export const editManifestSchema = z.object({
  version: z.literal(1),
  /** The raw render's length (ffprobe), seconds. */
  raw_duration_s: z.number().positive(),
  format: z.enum(["talking", "story"]),
  caption_style: z.enum(CAPTION_STYLE_NAMES),
  /** The caption pages burned in (lib/captions.ts groupPages), each ≤ 2 lines. */
  captions: z.array(z.object({ start_s: z.number(), end_s: z.number(), scale: z.number(), lines: z.array(z.array(word)) })),
  /** b-roll cut-ins in the video (clip = the provider's clip id). */
  broll: z.array(z.object({ start_s: z.number(), duration_s: z.number(), clip: z.string() })),
  /** The face stays on until hook_end_s and from cta_start_s (lib/broll.ts planBroll), or null. */
  protected: z.object({ hook_end_s: z.number(), cta_start_s: z.number() }).nullable(),
  /** The music bed (lib/music.ts) and its gain before ducking, or null for no music. */
  music: z.object({ bed_id: z.string(), gain_db: z.number() }).nullable(),
  ai_label: z.boolean(),
  watermark: z.boolean(),
  /** Requested extras missing from the real ffmpeg argv (lib/edit.ts notYetApplied). */
  not_applied: z.array(z.string()),
  /** p5-b2: b-roll clips Gate 5 rejected (never used again in this video's edits). Older manifests: none. */
  avoid_clips: z.array(z.string()).default([]),
});

export type EditManifest = z.infer<typeof editManifestSchema>;
