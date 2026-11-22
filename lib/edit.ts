import path from "node:path";
import { CAPTION_LAYOUT, CAPTION_STYLE_NAMES, MAX_PAGE_LINES, captionBoxTop } from "@/lib/captions";
import { audioFilterGraph, type LoudnormMeasured } from "@/lib/music";

// The ffmpeg command builder for the editor (Phase 4, docs/EDITOR-NOTES.md).
// Pure functions only: no files, no processes. lib/edit-flow.ts runs the
// result with execFile (never a shell), so each value is its own argument.
//
// Part A: scale + crop to 1080x1920, 30 fps, square pixels, burned-in
// captions (lib/captions.ts .ass file + our bundled fonts), H.264 yuv420p and
// AAC 48 kHz.
// Part B (p4-b2): b-roll cut-ins (overlay, only in their time window, under
// the captions), music bed ducked under the voice + two-pass loudnorm
// (lib/music.ts), the "AI-generated" label, the trial watermark, and
// -movflags +faststart (always). notYetApplied() checks the REAL argv for
// each requested extra: the p4-b1 publish guard.
// Option names checked against the installed ffmpeg 7.1 (`ffmpeg -h filter=overlay|drawtext`).

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

/** Centre trial mark (p5-a3): safe drawn height per px of font size, and the px kept clear above and below it. */
const CENTRE_HEIGHT_EM = 0.85;
const CENTRE_GAP_MARGIN = 4;

/**
 * The label and watermark (1080x1920 pixels). The label and the small trial
 * tag sit in the top row of the caption safe zone (lib/captions.ts
 * CAPTION_LAYOUT: below the top 250 px, inside the 140 px side margins), far
 * above the caption band, so they never cover captions or the mouth. Label
 * top-left, tag top-right. The big faint trial mark sits in the thin band
 * between the face zone and the captions (watermark_centre). Fonts: our
 * bundled Poppins (assets/fonts, OFL).
 */
export const EDIT_OVERLAYS = {
  /** Shown when ai_label is on (default on; PRODUCT.md "an AI label on every video"). */
  label: {
    text: "AI-generated", font_file: "Poppins-SemiBold.ttf", size: 34, colour: "white",
    box_colour: "black@0.55", pad: 12, x: 152, y: 262, chars: 12,
  },
  /** Trial videos only (videos.watermark; PRODUCT.md: the free trial preview is watermarked). */
  /**
   * The small corner tag. p4-b3: on a 50% black box like the label (legible on light b-roll);
   * same size and row as the label; x = the gap from the right edge to the text (box edge at 140).
   */
  watermark: {
    text: "TRIAL PREVIEW", font_file: "Poppins-Bold.ttf", size: 34, colour: "white",
    box_colour: "black@0.5", pad: 12, x: 152, y: 262, chars: 13,
  },
  /**
   * Trial videos also get a big, faint (35%) "TRIAL PREVIEW" across the frame, horizontally
   * centred, so a screenshot can't crop the corner tag off.
   * p5-a3 (Rowan; replaces the p4-b3 "middle third, ~70% width"): it sits in the lower-middle
   * band between the face zone (CAPTION_LAYOUT.face_zone.bottom, y 1150) and the highest
   * caption box of any style at 2 lines (captionBoxTop: big_words ≈ 1228), with gap_margin px
   * clear on both sides. The size is the largest whose SAFE height (height_em × size) fits that
   * band; y is the band's middle (drawtext y = centre - th/2). See CENTRE_MARK below.
   * width_em = [min, max] drawn text width per px of font size, MEASURED with the real ffmpeg
   * + Poppins Bold (tests/integration/edit-extras-ffmpeg.test.ts checks the drawn box);
   * height_em = a safe upper bound for the drawn height incl. the border (caps, no descenders).
   * Measured p4-b3 (ffmpeg 7.1.5) at 102 px: 7.40 em wide, 0.76 em tall incl. the 2 px border.
   * Result (p5-a3): size 82, y centre 1189 → safe box y 1154.2-1223.9; drawn ≈ 607 px wide (56%).
   */
  watermark_centre: {
    text: "TRIAL PREVIEW", font_file: "Poppins-Bold.ttf", colour: "white@0.35",
    border: 2, border_colour: "black@0.2", width_em: [7.2, 7.6], height_em: CENTRE_HEIGHT_EM, gap_margin: CENTRE_GAP_MARGIN,
    ...centreMark(CENTRE_HEIGHT_EM, CENTRE_GAP_MARGIN),
  },
} as const;

/**
 * p5-a3: the centre mark's font size and vertical centre, from the face zone and the caption
 * box maths (no copied numbers): the band is face_zone.bottom → the highest 2-line caption top.
 */
function centreMark(heightEm: number, margin: number): { size: number; y_centre: number } {
  const bandTop = CAPTION_LAYOUT.face_zone.bottom;
  const bandBottom = Math.min(...CAPTION_STYLE_NAMES.map((name) => captionBoxTop(name, MAX_PAGE_LINES)));
  return {
    size: Math.floor((bandBottom - bandTop - 2 * margin) / heightEm),
    y_centre: Math.round((bandTop + bandBottom) / 2),
  };
}

export type BrollCut = { path: string; start_s: number; duration_s: number };
export type MusicBed = { path: string };
export type EditExtras = {
  broll?: BrollCut[];
  music?: MusicBed | null;
  /** Loudness pass-1 numbers: pass 2 (loudnorm linear) is built into the final command. */
  loudness?: LoudnormMeasured | null;
  ai_label?: boolean;
  watermark?: boolean;
  /** Always applied (QA-SPEC Gate 4); kept so the guard can check it. */
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
  /** The raw video's length in seconds (needed for the music fade out). */
  durationS?: number;
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

const round = (s: number) => Math.round(s * 1000) / 1000;

/** Any input → 1080x1920 cover (scale up until both sides fill, crop the centre), square pixels, 30 fps. */
const COVER = `scale=${EDIT_OUTPUT.width}:${EDIT_OUTPUT.height}:force_original_aspect_ratio=increase,crop=${EDIT_OUTPUT.width}:${EDIT_OUTPUT.height},setsar=1,fps=${EDIT_OUTPUT.fps}`;

function labelFilter(fontsDir: string): string {
  const l = EDIT_OVERLAYS.label;
  return [
    `drawtext=fontfile=${escapeFilterValue(path.join(fontsDir, l.font_file))}`,
    `text=${escapeFilterValue(l.text)}`,
    "expansion=none", // no %{...} expansion: the text is drawn exactly as written
    `fontsize=${l.size}`,
    `fontcolor=${l.colour}`,
    "box=1",
    `boxcolor=${l.box_colour}`,
    `boxborderw=${l.pad}`,
    `x=${l.x}`,
    `y=${l.y}`,
  ].join(":");
}

/** Trial only: the big faint centre mark first, then the corner tag (on its dark box) on top. */
function watermarkFilter(fontsDir: string): string {
  const c = EDIT_OVERLAYS.watermark_centre;
  const centre = [
    `drawtext=fontfile=${escapeFilterValue(path.join(fontsDir, c.font_file))}`,
    `text=${escapeFilterValue(c.text)}`,
    "expansion=none",
    `fontsize=${c.size}`,
    `fontcolor=${c.colour}`,
    `borderw=${c.border}`,
    `bordercolor=${c.border_colour}`,
    "x=(w-tw)/2", // centred across: w = frame width, tw/th = text size
    `y=${c.y_centre}-th/2`, // centred on the band between the face and the captions (p5-a3)
  ].join(":");
  const w = EDIT_OVERLAYS.watermark;
  const tag = [
    `drawtext=fontfile=${escapeFilterValue(path.join(fontsDir, w.font_file))}`,
    `text=${escapeFilterValue(w.text)}`,
    "expansion=none",
    `fontsize=${w.size}`,
    `fontcolor=${w.colour}`,
    "box=1",
    `boxcolor=${w.box_colour}`,
    `boxborderw=${w.pad}`,
    `x=w-tw-${w.x}`, // right-aligned: w = frame width, tw = text width
    `y=${w.y}`,
  ].join(":");
  return `${centre},${tag}`;
}

export type VideoGraphOptions = {
  /** input = the clip's index on the ffmpeg command line. */
  broll?: { input: number; start_s: number; duration_s: number }[];
  aiLabel?: boolean;
  watermark?: boolean;
};

/**
 * [0:v] → cover 1080x1920 → square pixels → 30 fps → b-roll cut-ins (each
 * overlaid only between its start and end; the voice is untouched) →
 * captions (libass, our fonts; on top of the b-roll) → AI label → trial
 * watermark → [vout].
 */
export function videoFilterGraph(captionsPath: string, fontsDir: string, options: VideoGraphOptions = {}): string {
  const finish = [
    `subtitles=filename=${escapeFilterValue(captionsPath)}:fontsdir=${escapeFilterValue(fontsDir)}`,
    ...(options.aiLabel ? [labelFilter(fontsDir)] : []),
    ...(options.watermark ? [watermarkFilter(fontsDir)] : []),
  ].join(",");
  const cuts = options.broll ?? [];
  if (cuts.length === 0) return `[0:v]${COVER},${finish}[vout]`;
  const parts = [`[0:v]${COVER}[base]`];
  let last = "base";
  cuts.forEach((cut, i) => {
    const start = round(cut.start_s);
    const duration = round(cut.duration_s);
    const label = `b${i + 1}`;
    // setpts shifts the clip so its first frame lands at `start`; enable keeps it to its window.
    parts.push(`[${cut.input}:v]${COVER},trim=duration=${duration},setpts=PTS-STARTPTS+${start}/TB[${label}]`);
    parts.push(`[${last}][${label}]overlay=enable='between(t,${start},${round(start + duration)})':eof_action=pass[v${i + 1}]`);
    last = `v${i + 1}`;
  });
  parts.push(`[${last}]${finish}[vout]`);
  return parts.join(";");
}

const LEAD = ["-nostdin", "-hide_banner", "-nostats", "-loglevel", "info"];

/** The music bed input: looped forever (-stream_loop -1); the filter trims it to the video. */
const musicInput = (file: string) => ["-stream_loop", "-1", "-i", file];

/**
 * Loudness pass 1: the same audio chain as the final command, ending in
 * loudnorm print_format=json; nothing is written (-f null). lib/music.ts
 * parseLoudnormJson reads the numbers from stderr.
 */
export function buildLoudnessMeasureArgs(input: { input: string; musicPath: string | null; durationS: number }): string[] {
  const source = checkPath(input.input, "input video");
  const music = input.musicPath ? checkPath(input.musicPath, "music file") : null;
  return [
    ...LEAD,
    "-i", source,
    ...(music ? musicInput(music) : []),
    "-filter_complex", audioFilterGraph({ music: music ? { input: 1, durationS: input.durationS } : null, loudness: "measure" }),
    "-map", "[aout]", "-f", "null", "-",
  ];
}

export function buildEditArgs(input: EditArgsInput): string[] {
  const source = checkPath(input.input, "input video");
  const output = checkPath(input.output, "output video");
  const captions = checkPath(input.captionsPath, "captions file");
  const fonts = checkPath(input.fontsDir, "fonts folder");
  if (path.resolve(source) === path.resolve(output)) throw new Error("The output video must differ from the input.");
  const extras = input.extras ?? {};
  const broll = (extras.broll ?? []).map((cut) => ({ ...cut, path: checkPath(cut.path, "b-roll clip") }));
  const music = extras.music ? checkPath(extras.music.path, "music file") : null;
  if (music && !(input.durationS && input.durationS > 0)) throw new Error("The video length is needed to add music.");
  const musicIndex = 1 + broll.length;
  const graph = [
    videoFilterGraph(captions, fonts, {
      broll: broll.map((cut, i) => ({ input: 1 + i, start_s: cut.start_s, duration_s: cut.duration_s })),
      aiLabel: extras.ai_label === true,
      watermark: extras.watermark === true,
    }),
    audioFilterGraph({ music: music ? { input: musicIndex, durationS: input.durationS! } : null, loudness: extras.loudness ?? null }),
  ].join(";");
  const o = EDIT_OUTPUT;
  return [
    // -loglevel info: libass prints which font file it picked (we check that in tests).
    ...LEAD, "-y", // -y: our own temp output only
    "-i", source,
    ...broll.flatMap((cut) => ["-i", cut.path]),
    ...(music ? musicInput(music) : []),
    "-filter_complex", graph,
    "-map", "[vout]", "-map", "[aout]", // the voice track is required: no sound = an error, not a silent reel
    "-c:v", o.video_codec, "-preset", o.preset, "-crf", String(o.crf), "-pix_fmt", o.pix_fmt,
    "-c:a", o.audio_codec, "-b:a", o.audio_bitrate, "-ar", String(o.audio_rate), "-ac", String(o.audio_channels),
    // QA-SPEC Gate 4: the moov atom goes before the media data, so the video starts playing at once.
    "-movflags", "+faststart",
    output,
  ];
}

/**
 * p4-b1 publish guard (permanent): the extras a caller asked for that are NOT
 * in the argv ffmpeg actually runs. Checked on the real command, not on a
 * list of what we meant to do, so removing a filter from the builder makes the
 * edit go to the team (team_review), never to final_qa.
 */
export function notYetApplied(extras: EditExtras | undefined, args: string[]): string[] {
  if (!extras) return [];
  const graphAt = args.indexOf("-filter_complex");
  const graph = graphAt >= 0 ? (args[graphAt + 1] ?? "") : "";
  const inputs = args.flatMap((a, i) => (a === "-i" && i + 1 < args.length ? [args[i + 1]] : []));
  const cuts = extras.broll ?? [];
  const checks: [string, boolean, () => boolean][] = [
    [
      "broll",
      cuts.length > 0,
      () => cuts.every((c) => inputs.includes(c.path)) && (graph.match(/\]overlay=enable='between\(t,/g) ?? []).length === cuts.length,
    ],
    ["music", Boolean(extras.music), () => inputs.includes(extras.music!.path) && graph.includes("sidechaincompress=") && graph.includes("amix=")],
    ["loudness", Boolean(extras.loudness), () => /loudnorm=[^,;]*measured_I=[^,;]*:linear=true/.test(graph)],
    ["ai_label", extras.ai_label === true, () => graph.includes(`:text=${escapeFilterValue(EDIT_OVERLAYS.label.text)}:`)],
    // p4-b3: both trial marks (the centre one at x=(w-tw)/2 and the corner tag at x=w-tw-…).
    [
      "watermark",
      extras.watermark === true,
      () => {
        const marks = graph.split(/,(?=drawtext=)/).filter((f) => f.includes(`:text=${escapeFilterValue(EDIT_OVERLAYS.watermark.text)}:`));
        return marks.some((f) => f.includes(":x=(w-tw)/2:")) && marks.some((f) => f.includes(":x=w-tw-"));
      },
    ],
    ["faststart", extras.faststart === true, () => args.some((a, i) => a === "-movflags" && args[i + 1] === "+faststart")],
  ];
  return checks.filter(([, asked, applied]) => asked && !applied()).map(([name]) => name);
}
