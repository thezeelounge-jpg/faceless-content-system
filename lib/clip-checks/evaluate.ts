import type { ClipFaceOutput } from "@/lib/ai-schemas";
import type { ClipMeasurements } from "@/lib/clip-checks/media";
import { CLIP_CHECKS } from "@/lib/qa/config";

// Turns clip measurements and the face check into pass/fail results with a
// plain reshoot tip for every failed check (tips follow docs/RECORDING-GUIDE.md).
// The result is saved as consents.clip_checks.

export type FaceFrames = ClipFaceOutput["frames"];

export type ClipCheckCode = "duration" | "resolution" | "fps" | "loudness" | "silence" | "light" | "one_face" | "face_clear";

export type ClipCheck = {
  code: ClipCheckCode;
  label: string;
  passed: boolean;
  /** What we measured, in plain words for the admin. */
  value: string;
  tip: string | null;
};

export type ClipChecksResult = {
  passed: boolean;
  /**
   * SF4: the consents.clip_path these results measured. Approval only counts
   * results whose clip_path is the clip on the row now. (Missing on results
   * saved before Phase 3 part B; those need a re-check.)
   */
  clip_path?: string;
  checked_at: string;
  checks: ClipCheck[];
  /** The tips of the failed checks, in order (for the reshoot email). */
  tips: string[];
  measurements: ClipMeasurements;
};

export const TIPS = {
  too_short: "Record one continuous take of about 2 minutes (at least 15 seconds).",
  too_long: "Keep the clip under 10 minutes. About 2 minutes is best.",
  resolution: "Film at 1080p or 4K with the phone's back camera.",
  fps: "Set the camera to 30 frames per second.",
  quiet: "Speak up, or keep the phone within an arm's length. A clip-on microphone is best.",
  loud: "The sound is too loud. Move the microphone a little further away.",
  no_audio: "We couldn't hear you. Check the microphone is on and record again.",
  silence: "Keep talking the whole time. Pause for only one second every few sentences.",
  dark: "Face a window in daylight, or put one soft light in front of you. No bright light behind you.",
  bright: "The picture is too bright. Move away from direct sun or turn the light down.",
  extra_face: "Only you should be in the clip. Nobody else, and no photos or screens with faces.",
  no_face: "Stay in the frame the whole time, from the top of your head to the middle of your chest.",
  face_unclear:
    "Keep your face bright, sharp and fully visible: hair off your face, no hat or sunglasses, hands below your chin.",
} as const;

const c = CLIP_CHECKS;
const check = (code: ClipCheckCode, label: string, value: string, tip: string | null): ClipCheck => ({
  code,
  label,
  passed: tip === null,
  value,
  tip,
});

export function evaluateClip(m: ClipMeasurements, frames: FaceFrames, now: Date = new Date()): ClipChecksResult {
  const shortSide = Math.min(m.width, m.height);
  const clearFrames = frames.filter((f) => f.faces === 1 && f.face_clear).length;
  const enoughFrames = frames.length >= c.face_frames;

  const checks: ClipCheck[] = [
    check(
      "duration",
      "Length",
      `${Math.round(m.durationS)} seconds`,
      m.durationS < c.min_duration_s ? TIPS.too_short : m.durationS > c.max_duration_s ? TIPS.too_long : null,
    ),
    check("resolution", "Sharpness", `${m.width}x${m.height}`, shortSide < c.min_short_side_px ? TIPS.resolution : null),
    check("fps", "Smoothness", `${m.fps} fps`, m.fps < c.min_fps || m.fps > c.max_fps ? TIPS.fps : null),
    check(
      "loudness",
      "Sound level",
      m.loudnessLufs === null || !Number.isFinite(m.loudnessLufs) ? "no sound" : `${m.loudnessLufs} LUFS`,
      !m.hasAudio || m.loudnessLufs === null || !Number.isFinite(m.loudnessLufs)
        ? TIPS.no_audio
        : m.loudnessLufs < c.min_loudness_lufs
          ? TIPS.quiet
          : m.loudnessLufs > c.max_loudness_lufs
            ? TIPS.loud
            : null,
    ),
    check(
      "silence",
      "No long silences",
      `longest silence ${m.longestSilenceS} s`,
      m.hasAudio && m.longestSilenceS > c.max_silence_s ? TIPS.silence : null,
    ),
    check(
      "light",
      "Light",
      m.brightness === null ? "unknown" : `brightness ${m.brightness} of 255`,
      m.brightness === null || m.brightness < c.min_brightness ? TIPS.dark : m.brightness > c.max_brightness ? TIPS.bright : null,
    ),
    check(
      "one_face",
      "One face",
      enoughFrames ? `faces per frame: ${frames.map((f) => f.faces).join(", ")}` : "not checked",
      !enoughFrames ? TIPS.no_face : frames.some((f) => f.faces > 1) ? TIPS.extra_face : frames.some((f) => f.faces === 0) ? TIPS.no_face : null,
    ),
    check(
      "face_clear",
      "Face clearly visible",
      enoughFrames ? `${clearFrames} of ${frames.length} frames clear` : "not checked",
      !enoughFrames || clearFrames < c.min_clear_face_frames ? TIPS.face_unclear : null,
    ),
  ];

  // Two checks can share a tip (e.g. no face and too few frames); list it once.
  const tips = [...new Set(checks.flatMap((x) => (x.tip ? [x.tip] : [])))];
  return { passed: tips.length === 0, checked_at: now.toISOString(), checks, tips, measurements: m };
}
