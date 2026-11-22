// Gate 4 checks (QA-SPEC "Gate 4: Technical QA"). Pure functions: no files, no processes.
// lib/qa/technical-gate.ts runs ffprobe/ffmpeg on the final file and passes the numbers here,
// with the edit manifest (what the editor built, lib/qa/edit-manifest.ts) and the transcript.
// Every number comes from lib/qa/config.ts (TECH_QA, BROLL, MUSIC).
import { CAPTION_LAYOUT, estimatePageBox, type CaptionPage } from "@/lib/captions";
import type { TimeRange } from "@/lib/qa/audio-checks";
import { BROLL, MUSIC, TECH_QA } from "@/lib/qa/config";
import type { EditManifest } from "@/lib/qa/edit-manifest";
import { wholeWordPattern, type QaIssue } from "@/lib/qa/script-checks";
import type { Transcript } from "@/lib/stt";

export type FinalProbe = {
  width: number;
  height: number;
  fps: number;
  videoCodec: string | null;
  pixFmt: string | null;
  audioCodec: string | null;
  sampleRate: number | null;
  durationS: number;
  sizeBytes: number;
};
export type Loudness = { i: number; tp: number };

const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: string | undefined) => (v === undefined ? NaN : v.endsWith("inf") ? (v.startsWith("-") ? -Infinity : Infinity) : Number(v));

type ProbeStream = {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  sample_rate?: string;
};

function rate(value: string | undefined): number {
  const [a, b] = (value ?? "").split("/").map(Number);
  return b > 0 && Number.isFinite(a) ? Math.round((a / b) * 1000) / 1000 : 0;
}

/** ffprobe -show_format -show_streams JSON → what Gate 4 checks. */
export function parseFinalProbe(json: string): FinalProbe {
  const data = JSON.parse(json) as { streams?: ProbeStream[]; format?: { duration?: string; size?: string } };
  const video = data.streams?.find((s) => s.codec_type === "video");
  const audio = data.streams?.find((s) => s.codec_type === "audio");
  return {
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    fps: rate(video?.avg_frame_rate) || rate(video?.r_frame_rate),
    videoCodec: video?.codec_name ?? null,
    pixFmt: video?.pix_fmt ?? null,
    audioCodec: audio?.codec_name ?? null,
    sampleRate: audio?.sample_rate ? Number(audio.sample_rate) : null,
    durationS: Number(data.format?.duration ?? 0),
    sizeBytes: Number(data.format?.size ?? 0),
  };
}

/** ebur128 (peak=true): integrated loudness and true peak from the Summary (never the per-frame lines). */
export function parseEbur128(stderr: string): Loudness | null {
  const at = stderr.lastIndexOf("Summary:");
  if (at < 0) return null;
  const summary = stderr.slice(at);
  const i = summary.match(/I:\s+(-?inf|-?\d+(?:\.\d+)?)\s+LUFS/)?.[1];
  const tp = summary.match(/Peak:\s+(-?inf|-?\d+(?:\.\d+)?)\s+dBFS/)?.[1];
  if (i === undefined || tp === undefined) return null;
  return { i: num(i), tp: num(tp) };
}

/** blackdetect: "black_start:0 black_end:1 black_duration:1" lines. */
export function parseBlackdetect(stderr: string): TimeRange[] {
  return [...stderr.matchAll(/black_start:\s*(-?[\d.]+)\s+black_end:\s*([\d.]+)/g)].map((m) => ({
    start_s: round2(Math.max(0, Number(m[1]))),
    end_s: round2(Number(m[2])),
  }));
}

/** freezedetect: freeze_start / freeze_end lines; a freeze still running at the end lasts until durationS. */
export function parseFreezedetect(stderr: string, durationS: number): TimeRange[] {
  const ranges: TimeRange[] = [];
  let open: number | null = null;
  for (const line of stderr.split("\n")) {
    const start = line.match(/freezedetect\.freeze_start:\s*(-?[\d.]+)/);
    if (start) open = Math.max(0, Number(start[1]));
    const end = line.match(/freezedetect\.freeze_end:\s*([\d.]+)/);
    if (end && open !== null) {
      ranges.push({ start_s: round2(open), end_s: round2(Number(end[1])) });
      open = null;
    }
  }
  if (open !== null) ranges.push({ start_s: round2(open), end_s: round2(durationS) });
  return ranges;
}

/**
 * +faststart: walks the MP4's top-level boxes (size + type headers, 32- or 64-bit sizes) and
 * answers which of moov / mdat comes first. `read(offset, length)` returns the bytes there (null
 * past the end). Null = not a readable MP4.
 */
export function firstOfMoovMdat(read: (offset: number, length: number) => Buffer | null): "moov" | "mdat" | null {
  let offset = 0;
  for (let n = 0; n < 64; n++) {
    const header = read(offset, 16);
    if (!header || header.length < 8) return null;
    let size = header.readUInt32BE(0);
    const type = header.toString("latin1", 4, 8);
    if (!/^[a-z0-9]{4}$/i.test(type)) return null;
    if (type === "moov" || type === "mdat") return type;
    if (size === 1) {
      if (header.length < 16) return null;
      size = Number(header.readBigUInt64BE(8));
    }
    if (size < 8) return null;
    offset += size;
  }
  return null;
}

export type TechnicalInput = {
  probe: FinalProbe;
  boxFirst: "moov" | "mdat" | null;
  loudness: Loudness | null;
  black: TimeRange[];
  freeze: TimeRange[];
  /** Integrated loudness of each stem (the same chain, one side at a time), or null when not measured. */
  stems: { voice: number; music: number } | null;
  manifest: EditManifest;
  transcript: Transcript;
  displayText: string;
  /** Brand names to be spelled right in captions (brand name + approved dictionary words). */
  names: string[];
  /** videos.ai_label / videos.watermark (the row decides, not the edit). */
  aiLabel: boolean;
  watermark: boolean;
  maxSeconds: number;
};

const hard = (code: string, detail: string, at: number | null = null): QaIssue => ({ code, detail, at_seconds: at, severity: "hard" });

export function technicalIssues(input: TechnicalInput): QaIssue[] {
  const { probe, manifest } = input;
  const issues: QaIssue[] = [];
  const q = TECH_QA;

  // Format.
  const wrong: string[] = [];
  if (probe.width !== q.width || probe.height !== q.height) wrong.push(`${probe.width}x${probe.height} (want ${q.width}x${q.height})`);
  if (Math.abs(probe.fps - q.fps) > 0.01) wrong.push(`${probe.fps} fps (want ${q.fps})`);
  if (probe.videoCodec !== q.video_codec) wrong.push(`video ${probe.videoCodec ?? "missing"} (want ${q.video_codec})`);
  if (probe.pixFmt !== q.pix_fmt) wrong.push(`pixels ${probe.pixFmt ?? "unknown"} (want ${q.pix_fmt})`);
  if (probe.audioCodec !== q.audio_codec) wrong.push(`audio ${probe.audioCodec ?? "missing"} (want ${q.audio_codec})`);
  if (probe.sampleRate !== q.audio_rate) wrong.push(`${probe.sampleRate ?? "no"} Hz audio (want ${q.audio_rate})`);
  if (wrong.length > 0) issues.push(hard("format", `Wrong format: ${wrong.join(", ")}.`));
  if (input.boxFirst !== "moov") issues.push(hard("faststart", "The file does not start fast (the moov box is not before mdat)."));

  // Duration and size.
  const maxDuration = input.maxSeconds + q.duration_slack_s;
  if (probe.durationS > maxDuration) issues.push(hard("duration_max", `${round2(probe.durationS)} s long; the plan allows ${maxDuration} s.`));
  const maxBytes = q.max_mb_per_60s * 1024 * 1024 * (probe.durationS / 60);
  if (probe.sizeBytes > maxBytes) {
    issues.push(hard("file_size", `${round2(probe.sizeBytes / 1024 / 1024)} MB for ${round2(probe.durationS)} s (limit ${q.max_mb_per_60s} MB per 60 s).`));
  }

  // Loudness and music.
  if (!input.loudness || !Number.isFinite(input.loudness.i)) {
    issues.push(hard("loudness", "The loudness could not be measured."));
  } else {
    if (Math.abs(input.loudness.i - q.loudness_target_lufs) > q.loudness_tolerance_lu) {
      issues.push(hard("loudness", `${input.loudness.i} LUFS (want ${q.loudness_target_lufs} ±${q.loudness_tolerance_lu}).`));
    }
    if (input.loudness.tp > q.max_true_peak_dbtp) issues.push(hard("true_peak", `True peak ${input.loudness.tp} dBTP (limit ${q.max_true_peak_dbtp}).`));
  }
  if (manifest.music) {
    if (!input.stems) {
      issues.push(hard("music_level", "The music level could not be measured."));
    } else if (input.stems.voice - input.stems.music < MUSIC.min_voice_over_music_db) {
      const gap = round2(input.stems.voice - input.stems.music);
      issues.push(hard("music_level", `The music is only ${gap} dB under the voice (needs ${MUSIC.min_voice_over_music_db}).`));
    }
  }

  // Black and frozen frames.
  for (const r of input.black) {
    if (r.end_s - r.start_s > q.max_black_s) issues.push(hard("black_frames", `${round2(r.end_s - r.start_s)} s of black (limit ${q.max_black_s} s).`, r.start_s));
  }
  for (const r of input.freeze) {
    if (r.end_s - r.start_s > q.max_freeze_s) issues.push(hard("frozen_frames", `${round2(r.end_s - r.start_s)} s frozen (limit ${q.max_freeze_s} s).`, r.start_s));
  }

  // Captions: timing (words with their own speech-to-text time), text, layout.
  const words = manifest.captions.flatMap((page) => page.lines.flat());
  for (const w of words) {
    if (!["matched", "substituted", "merged"].includes(w.source) || w.stt_indexes.length === 0) continue;
    const heard = input.transcript.words[w.stt_indexes[0]];
    if (!heard) continue;
    const off = Math.abs(w.start_s - heard.start_s);
    if (off > q.caption_timing_tolerance_s + 1e-9) {
      issues.push(hard("caption_timing", `"${w.text}" shows ${Math.round(off * 1000)} ms off its spoken time (limit ${q.caption_timing_tolerance_s * 1000} ms).`, round2(w.start_s)));
    }
  }
  const captionText = words.map((w) => w.text).join(" ");
  const wanted = input.displayText.split(/\s+/).filter(Boolean).join(" ");
  if (captionText !== wanted) issues.push(hard("caption_text", "The captions do not match the script's display text."));
  const misspelt = input.names.filter((name) => name.trim() && wholeWordPattern(name, "iu").test(wanted) && !wholeWordPattern(name, "iu").test(captionText));
  if (misspelt.length > 0) issues.push(hard("caption_brand_name", `Spelled wrong in the captions: ${misspelt.join(", ")}.`));
  if (manifest.captions.some((page) => page.lines.length > q.caption_max_lines)) {
    issues.push(hard("caption_lines", `A caption page has more than ${q.caption_max_lines} lines.`));
  }
  const { width, height } = CAPTION_LAYOUT;
  const outside = manifest.captions.find((page) => {
    const box = estimatePageBox(page as CaptionPage, manifest.caption_style);
    return box.top < q.safe_zone.top * height || box.bottom > (1 - q.safe_zone.bottom) * height || box.right > (1 - q.safe_zone.right) * width;
  });
  if (outside) issues.push(hard("caption_safe_zone", "A caption leaves the safe zone (top 12%, bottom 20%, right 12%).", round2(outside.start_s)));

  // b-roll.
  const slack = q.broll_slack_s;
  const badCut = manifest.broll.find((c) => c.duration_s < BROLL.min_cut_s - slack || c.duration_s > BROLL.max_cut_s + slack);
  if (badCut) issues.push(hard("broll_cut_length", `A b-roll cut lasts ${badCut.duration_s} s (want ${BROLL.min_cut_s} to ${BROLL.max_cut_s} s).`, badCut.start_s));
  const coverage = manifest.broll.reduce((sum, c) => sum + c.duration_s, 0);
  const maxCoverage = BROLL.max_coverage[manifest.format] * probe.durationS;
  if (coverage > maxCoverage + slack) {
    issues.push(hard("broll_coverage", `b-roll covers ${round2(coverage)} s (limit ${round2(maxCoverage)} s for a ${manifest.format} video).`));
  }
  const p = manifest.protected;
  const overFace = manifest.broll.find((c) => !p || c.start_s < p.hook_end_s - slack || c.start_s + c.duration_s > p.cta_start_s + slack);
  if (overFace) issues.push(hard("broll_over_face", "b-roll covers the face during the hook or the call to action.", overFace.start_s));

  // Labels.
  if (input.aiLabel && (!manifest.ai_label || manifest.not_applied.includes("ai_label"))) issues.push(hard("ai_label_missing", "The AI-generated label is missing."));
  if (input.watermark && (!manifest.watermark || manifest.not_applied.includes("watermark"))) issues.push(hard("watermark_missing", "The trial watermark is missing."));
  if (!input.watermark && manifest.watermark) issues.push(hard("watermark_not_trial", "A watermark is on a video that is not a trial."));
  return issues;
}
