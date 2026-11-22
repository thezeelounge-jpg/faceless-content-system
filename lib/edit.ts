import path from "node:path";

// The ffmpeg command builder for the editor (Phase 4, docs/EDITOR-NOTES.md).
// Pure functions only: no files, no processes. lib/edit-flow.ts runs the
// result with execFile (never a shell), so each value is its own argument.
//
// Part A: scale + crop to 1080x1920, 30 fps, square pixels, burned-in
// captions (lib/captions.ts .ass file + our bundled fonts), H.264 yuv420p and
// AAC 48 kHz. Part B (b-roll, music + loudness, AI label, watermark,
// +faststart) plugs into EditExtras; until then notYetApplied() lists any
// extra a caller asked for, and the args do not change.

/** The finished reel (QA-SPEC Gate 4: 1080x1920, 30 fps, H.264 yuv420p, AAC 48 kHz). */
export const EDIT_OUTPUT = {
  width: 1080,
  height: 1920,
  fps: 30,
  video_codec: "libx264",
  /** x264 speed/size trade-off; "medium" is x264's own default. */
  preset: "medium",
  /** Constant quality (lower = better and bigger). 20 keeps a 60 s reel well under 100 MB. */
  crf: 20,
  pix_fmt: "yuv420p",
  audio_codec: "aac",
  audio_bitrate: "192k",
  audio_rate: 48000,
  audio_channels: 2,
} as const;

/** Part B extension points. Typed now so callers and the task payload don't change later. */
export type BrollCut = { path: string; start_s: number; duration_s: number };
export type MusicBed = { path: string; gain_db: number };
export type EditExtras = {
  broll?: BrollCut[];
  music?: MusicBed | null;
  ai_label?: boolean;
  watermark?: boolean;
  faststart?: boolean;
};

export type EditArgsInput = {
  /** The raw HeyGen MP4 (absolute path). */
  input: string;
  /** Where ffmpeg writes the finished MP4 (absolute path, a temp folder). */
  output: string;
  /** The .ass file from lib/captions.ts (absolute path). */
  captionsPath: string;
  /** The folder holding the caption fonts (assets/fonts, absolute path). */
  fontsDir: string;
  extras?: EditExtras;
};

/**
 * Level 1 (one option value): escape \ ' and : with a backslash.
 * ffmpeg-filters "Notes on filtergraph escaping": "A first level escaping
 * affects the content of each filter option value, which may contain the
 * special character : used to separate values, or one of the escaping characters \'."
 */
export function escapeFilterOption(value: string): string {
  return value.replace(/[\\':]/g, (c) => `\\${c}`);
}

/**
 * Level 2 (the whole filter description): escape \ ' [ ] , ; with a backslash.
 * Same docs: "A second level escaping affects the whole filter description,
 * which may contain the escaping characters \' or the special characters [],;".
 */
export function escapeFilterGraph(value: string): string {
  return value.replace(/[\\'[\],;]/g, (c) => `\\${c}`);
}

/** A path or text placed as one option value inside a filtergraph: both levels. */
export function escapeFilterValue(value: string): string {
  return escapeFilterGraph(escapeFilterOption(value));
}

function checkPath(file: string, what: string): string {
  if (!path.isAbsolute(file)) throw new Error(`The ${what} must be an absolute file path.`);
  return file;
}

/**
 * [0:v] → cover 1080x1920 (scale up until both sides fill, crop the rest from
 * the centre) → square pixels → constant 30 fps → captions (libass, fonts
 * from fontsDir only add to what the system has) → [vout].
 */
export function videoFilterGraph(captionsPath: string, fontsDir: string): string {
  const { width: w, height: h, fps } = EDIT_OUTPUT;
  return [
    `[0:v]scale=${w}:${h}:force_original_aspect_ratio=increase`,
    `crop=${w}:${h}`,
    "setsar=1",
    `fps=${fps}`,
    `subtitles=filename=${escapeFilterValue(captionsPath)}:fontsdir=${escapeFilterValue(fontsDir)}[vout]`,
  ].join(",");
}

export function buildEditArgs(input: EditArgsInput): string[] {
  const source = checkPath(input.input, "input video");
  const output = checkPath(input.output, "output video");
  const captions = checkPath(input.captionsPath, "captions file");
  const fonts = checkPath(input.fontsDir, "fonts folder");
  if (path.resolve(source) === path.resolve(output)) throw new Error("The output video must differ from the input.");
  const o = EDIT_OUTPUT;
  return [
    // -loglevel info: libass prints which font file it picked (we check that in tests).
    "-nostdin", "-hide_banner", "-nostats", "-loglevel", "info", "-y", // -y: our own temp output only
    "-i", source,
    "-filter_complex", videoFilterGraph(captions, fonts),
    "-map", "[vout]", "-map", "0:a:0", // the voice track is required: no sound = an error, not a silent reel
    "-c:v", o.video_codec, "-preset", o.preset, "-crf", String(o.crf), "-pix_fmt", o.pix_fmt,
    "-c:a", o.audio_codec, "-b:a", o.audio_bitrate, "-ar", String(o.audio_rate), "-ac", String(o.audio_channels),
    output,
  ];
}

/** The part B extras a caller asked for that this version does not build yet. */
export function notYetApplied(extras: EditExtras | undefined): string[] {
  if (!extras) return [];
  const asked: [string, boolean][] = [
    ["broll", (extras.broll?.length ?? 0) > 0],
    ["music", Boolean(extras.music)],
    ["ai_label", extras.ai_label === true],
    ["watermark", extras.watermark === true],
    ["faststart", extras.faststart === true],
  ];
  return asked.filter(([, on]) => on).map(([name]) => name);
}
