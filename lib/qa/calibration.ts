// p5-b3: calibration (PROMPTS Phase 5 item 8: "after the first 10 real videos, show me each gate's
// scores and propose threshold changes. Don't change thresholds until I agree").
//
// READ ONLY. Pure: rows come from lib/qa/calibration-store.ts. The current thresholds are READ from
// lib/qa/config.ts; a proposal is only shown, never written (tests/unit/calibration.test.ts).
//
// A REAL video = a post video with a succeeded, non-mock HeyGen render row (provider_usage). Mock
// videos never count toward CALIBRATION.min_real_videos and their scores are left out.
//
// The proposal rule (simple on purpose, so the owner can check it):
// - per gate, each real video's LATEST score (Gate 1: voice match of its script; Gate 3: WER, per
//   language; Gate 4: integrated loudness; Gate 5: realism).
// - "leaked" = videos a PERSON rejected in the QA queue (gate 'human') whose score still passed the
//   gate. If any: propose the value just past the worst leaked score (one step stricter), because
//   that would have caught them. If none: keep the current value.
// - Gate 4 loudness is a band from QA-SPEC (-14 ±1.5 LUFS): shown, never re-proposed here.
import { AUDIO_QA, CALIBRATION, SCRIPT_QA, TECH_QA, VISUAL_QA } from "@/lib/qa/config";
import { GATE_LABELS } from "@/lib/qa/gates";

export type CalibrationInput = {
  renders: { video_id: string; mock: boolean }[];
  videos: { id: string; script_id: string | null; language: string }[];
  /** Oldest first (the latest score per video wins). */
  reports: { gate: string; passed: boolean; score: number | null; video_id: string | null; script_id: string | null }[];
};

export type GateCalibration = {
  key: string;
  label: string;
  direction: "higher" | "lower" | "band";
  threshold: number;
  count: number;
  stats: { min: number; median: number; max: number } | null;
  /** How many of the scores pass the current threshold. */
  passing: number;
  proposed: number;
  reasoning: string;
};

export type CalibrationResult =
  | { ready: false; realVideos: number; needed: number }
  | { ready: true; realVideos: number; gates: GateCalibration[] };

type Spec = { key: string; label: string; gate: string; direction: "higher" | "lower" | "band"; threshold: number; step: number; max?: number; language?: string };

const round = (n: number) => Math.round(n * 10_000) / 10_000;

function specs(languages: string[]): Spec[] {
  const audio = languages
    .filter((lang): lang is keyof typeof AUDIO_QA.max_wer => lang in AUDIO_QA.max_wer)
    .map<Spec>((lang) => ({
      key: `audio_${lang}`,
      label: `${GATE_LABELS.audio} (word error rate, ${lang})`,
      gate: "audio",
      direction: "lower",
      threshold: AUDIO_QA.max_wer[lang],
      step: 0.01,
      language: lang,
    }));
  return [
    { key: "script", label: `${GATE_LABELS.script} (voice match, soft)`, gate: "script", direction: "higher", threshold: SCRIPT_QA.voice_pass_score, step: 1, max: 10 },
    ...audio,
    { key: "technical", label: `${GATE_LABELS.technical} (loudness, LUFS)`, gate: "technical", direction: "band", threshold: TECH_QA.loudness_target_lufs, step: 0 },
    { key: "visual", label: `${GATE_LABELS.visual} (realism)`, gate: "visual", direction: "higher", threshold: VISUAL_QA.pass_realism_score, step: 1, max: 10 },
  ];
}

const passes = (spec: Spec, score: number) =>
  spec.direction === "higher"
    ? score >= spec.threshold
    : spec.direction === "lower"
      ? score <= spec.threshold
      : Math.abs(score - spec.threshold) <= TECH_QA.loudness_tolerance_lu;

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : round((sorted[mid - 1] + sorted[mid]) / 2);
}

export function calibrate(input: CalibrationInput): CalibrationResult {
  const realIds = new Set(input.renders.filter((r) => r.mock === false).map((r) => r.video_id));
  const videos = input.videos.filter((v) => realIds.has(v.id));
  const realVideos = videos.length;
  if (realVideos < CALIBRATION.min_real_videos) return { ready: false, realVideos, needed: CALIBRATION.min_real_videos - realVideos };

  const rejected = new Set(input.reports.filter((r) => r.gate === "human" && !r.passed && r.video_id && realIds.has(r.video_id)).map((r) => r.video_id!));
  const languages = [...new Set(videos.map((v) => v.language))].sort();

  const gates = specs(languages).map<GateCalibration>((spec) => {
    // Each real video's latest score for this gate (Gate 1 is saved per script).
    const scores = new Map<string, number>();
    for (const video of videos) {
      if (spec.language && video.language !== spec.language) continue;
      for (const r of input.reports) {
        if (r.gate !== spec.gate || r.score === null) continue;
        const mine = spec.gate === "script" ? r.script_id !== null && r.script_id === video.script_id : r.video_id === video.id;
        if (mine) scores.set(video.id, Number(r.score));
      }
    }
    const values = [...scores.values()].sort((a, b) => a - b);
    const stats = values.length === 0 ? null : { min: values[0], median: median(values), max: values[values.length - 1] };
    const passing = values.filter((v) => passes(spec, v)).length;
    const base = { key: spec.key, label: spec.label, direction: spec.direction, threshold: spec.threshold, count: values.length, stats, passing };

    if (spec.direction === "band") {
      return {
        ...base,
        proposed: spec.threshold,
        reasoning: `${passing} of ${values.length} inside ${spec.threshold} ±${TECH_QA.loudness_tolerance_lu} LUFS. A fixed band from QA-SPEC: keep.`,
      };
    }
    const leaked = [...scores.entries()].filter(([id, v]) => rejected.has(id) && passes(spec, v)).map(([, v]) => v);
    if (leaked.length === 0) {
      return {
        ...base,
        proposed: spec.threshold,
        reasoning: `${passing} of ${values.length} pass. No video a person rejected passed this gate: keep ${spec.threshold}.`,
      };
    }
    const proposed =
      spec.direction === "higher"
        ? Math.min(Math.max(...leaked) + spec.step, spec.max ?? Infinity)
        : round(Math.max(Math.min(...leaked) - spec.step, 0));
    const n = leaked.length;
    return {
      ...base,
      proposed,
      reasoning: `${n} video${n === 1 ? "" : "s"} passed this gate but a person rejected ${n === 1 ? "it" : "them"} in the QA queue (worst score ${
        spec.direction === "higher" ? Math.max(...leaked) : Math.min(...leaked)
      }). ${proposed} would have caught ${n === 1 ? "it" : "them"}; check the queue notes before agreeing.`,
    };
  });
  return { ready: true, realVideos, gates };
}
