import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { PlainError } from "@/lib/plain-error";
import { LOUDNESS, MUSIC } from "@/lib/qa/config";

// Music bed + loudness (Phase 4 part B, docs/EDITOR-NOTES.md "Music and loudness").
// Pure filter strings (lib/edit.ts puts them in the ffmpeg command) plus the
// music set. Option names and ranges checked against the installed ffmpeg
// 7.1 (`ffmpeg -h filter=loudnorm|sidechaincompress|amix|afade|atrim`).
//
// Audio chain (one -filter_complex, voice = input 0, music = input M):
//   voice  → 48 kHz stereo float → split: one copy to the mix, one as the sidechain
//   music  → 48 kHz stereo float → trimmed to the video (the input loops: -stream_loop -1)
//          → fade in / fade out → turned down MUSIC.bed_gain_db
//          → sidechaincompress (ducked further whenever the voice is there)
//   mix    → amix (normalize=0: no automatic halving) → loudnorm → 48 kHz
// Loudness is TWO-PASS: pass 1 runs the same chain into loudnorm with
// print_format=json and writes nothing (-f null); pass 2 gives loudnorm the
// measured values with linear=true, so the whole mix gets one gain.

export type LoudnormMeasured = {
  input_i: number;
  input_tp: number;
  input_lra: number;
  input_thresh: number;
  target_offset: number;
};

export const LOUDNORM_SILENT = "The voice track is silent, so its loudness can't be set.";
const LOUDNORM_UNREADABLE = "The loudness of the mix could not be measured (ffmpeg gave no loudnorm numbers).";

const targets = () => `I=${LOUDNESS.target_i}:TP=${LOUDNESS.target_tp}:LRA=${LOUDNESS.target_lra}`;

/** Pass 1: measure only. */
export function loudnormMeasureFilter(): string {
  return `loudnorm=${targets()}:print_format=json`;
}

/** ffmpeg 7.1 ranges: measured_I -99..0, measured_TP -99..99, measured_LRA 0..99, measured_thresh -99..0, offset -99..99. */
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Pass 2: apply the pass-1 numbers, one linear gain when loudnorm can. */
export function loudnormApplyFilter(m: LoudnormMeasured): string {
  return [
    `loudnorm=${targets()}`,
    `measured_I=${clamp(m.input_i, -99, 0)}`,
    `measured_TP=${clamp(m.input_tp, -99, 99)}`,
    `measured_LRA=${clamp(m.input_lra, 0, 99)}`,
    `measured_thresh=${clamp(m.input_thresh, -99, 0)}`,
    `offset=${clamp(m.target_offset, -99, 99)}`,
    "linear=true",
    "print_format=summary",
  ].join(":");
}

const num = z.string().trim().regex(/^-?(inf|\d+(\.\d+)?)$/).transform((s) => (s.endsWith("inf") ? (s.startsWith("-") ? -Infinity : Infinity) : Number(s)));
const pass1Schema = z.object({ input_i: num, input_tp: num, input_lra: num, input_thresh: num, target_offset: num });

/** The last `{ ... "input_i" ... }` block loudnorm printed on stderr, as numbers. */
export function parseLoudnormJson(stderr: string): LoudnormMeasured {
  const block = [...stderr.matchAll(/\{[^{}]*\}/g)].map((m) => m[0]).filter((b) => b.includes('"input_i"')).at(-1);
  if (!block) throw new PlainError(LOUDNORM_UNREADABLE);
  let parsed: z.infer<typeof pass1Schema>;
  try {
    parsed = pass1Schema.parse(JSON.parse(block));
  } catch (error) {
    throw new PlainError(LOUDNORM_UNREADABLE, { cause: error });
  }
  if (!Number.isFinite(parsed.input_i) || !Number.isFinite(parsed.input_thresh)) throw new PlainError(LOUDNORM_SILENT);
  // A silent part can make the true peak -inf; loudnorm accepts down to -99.
  return { ...parsed, input_tp: Number.isFinite(parsed.input_tp) ? parsed.input_tp : -99 };
}

export type AudioGraphInput = {
  /** The music input's index on the ffmpeg command line, and the video length (fade out at the end). */
  music?: { input: number; durationS: number } | null;
  /** Pass-1 numbers (pass 2), "measure" (pass 1), or null (no loudness step: stems only). */
  loudness: LoudnormMeasured | "measure" | null;
  /** "voice" / "music": render one side of the same chain only (Gate 4 stem check). Default "mix". */
  stem?: "mix" | "voice" | "music";
};

const FORMAT = "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo";
const round = (s: number) => Math.round(s * 1000) / 1000;

/** The audio part of -filter_complex; always ends in [aout]. */
export function audioFilterGraph(input: AudioGraphInput): string {
  const tail =
    input.loudness === null ? "" : input.loudness === "measure" ? `,${loudnormMeasureFilter()}` : `,${loudnormApplyFilter(input.loudness)},aresample=48000`;
  if (!input.music) return `[0:a]${FORMAT}${tail}[aout]`;
  const d = round(input.music.durationS);
  const duck = MUSIC.duck;
  const parts = [
    `[0:a]${FORMAT},asplit=2[voice][sc]`,
    `[${input.music.input}:a]${FORMAT},atrim=duration=${d},afade=t=in:d=${MUSIC.fade_in_s},` +
      `afade=t=out:st=${round(Math.max(0, d - MUSIC.fade_out_s))}:d=${MUSIC.fade_out_s},volume=${MUSIC.bed_gain_db}dB[bed]`,
    `[bed][sc]sidechaincompress=threshold=${duck.threshold}:ratio=${duck.ratio}:attack=${duck.attack_ms}:release=${duck.release_ms}[music]`,
  ];
  const stem = input.stem ?? "mix";
  if (stem === "voice") parts.push(`[music]anullsink;[voice]anull${tail}[aout]`);
  else if (stem === "music") parts.push(`[voice]anullsink;[music]anull${tail}[aout]`);
  else parts.push(`[voice][music]amix=inputs=2:duration=first:normalize=0${tail}[aout]`);
  return parts.join(";");
}

// ---------------------------------------------------------------------------
// The music set
// ---------------------------------------------------------------------------

export type MusicBedFile = { id: string; file: string; duration_s: number };

export interface MusicLibrary {
  /** One bed for this video (the same video always gets the same bed). Throws MUSIC_NOT_SET_UP when there are none. */
  pick(seed: string): MusicBedFile;
}

export const MUSIC_NOT_SET_UP = "No music beds are set up yet.";
export const MOCK_MUSIC_DIR = path.join(process.cwd(), "tests", "fixtures", "music");

const bedsSchema = z.object({ beds: z.array(z.object({ id: z.string().min(1), file: z.string().min(1), duration_s: z.number().positive() })) });

/**
 * The mock set: tests/fixtures/music/beds.json (made by scripts/make-fixtures.sh).
 * The real royalty-free set will live in Supabase Storage (a later step); it
 * will be prepared the same way (about -14 LUFS, loops cleanly).
 */
export function fixtureMusicLibrary(dir: string = MOCK_MUSIC_DIR): MusicLibrary {
  return {
    pick(seed) {
      let beds: MusicBedFile[] = [];
      try {
        beds = bedsSchema
          .parse(JSON.parse(readFileSync(path.join(dir, "beds.json"), "utf8")))
          .beds.map((b) => ({ ...b, file: path.join(dir, b.file) }))
          .filter((b) => existsSync(b.file));
      } catch {
        beds = [];
      }
      if (beds.length === 0) throw new PlainError(MUSIC_NOT_SET_UP);
      const n = createHash("sha256").update(seed).digest().readUInt32BE(0);
      return beds[n % beds.length];
    },
  };
}

export function getMusicLibrary(): MusicLibrary {
  return fixtureMusicLibrary();
}
