// Every QA threshold lives here and only here (docs/QA-SPEC.md).
// These are STARTING values. Calibrate them on the first 20 real videos
// (Phase 5, step 8) and note the date in CLAUDE.md "QA thresholds last calibrated".

/** Gate 1: Script QA. */
export const SCRIPT_QA = {
  /** The hook (first sentence) may have at most this many words. */
  hook_max_words: 12,
  /** Voice match is scored 1 to 10 by Claude; this or more passes. Soft check. */
  voice_pass_score: 7,
  /** One automatic fix per gate. */
  max_rewrites: 1,
} as const;

/**
 * Consent clip checks (Phase 3), before a twin is made.
 * Duration limits are HeyGen's (docs "Video to Avatar": 15 to 600 seconds,
 * about 2 minutes recommended). HeyGen accepts 640 px on the long side; we ask
 * for 1080 on the SHORT side because the twin is only as sharp as the clip.
 * Fps: not in HeyGen's docs (UNCONFIRMED); RECORDING-GUIDE asks for 30.
 */
export const CLIP_CHECKS = {
  min_duration_s: 15,
  max_duration_s: 600,
  min_short_side_px: 1080,
  min_fps: 25,
  max_fps: 61,
  /** Integrated loudness (EBU R128). */
  min_loudness_lufs: -30,
  max_loudness_lufs: -6,
  /** Anything quieter than this, for at least silence_min_s, is a silence. */
  silence_noise_db: -40,
  silence_min_s: 0.5,
  /** The longest allowed silence. The guide asks for 1-second pauses. */
  max_silence_s: 3,
  /** Average brightness (YAVG, 0 to 255). */
  min_brightness: 70,
  max_brightness: 220,
  /** Frames sent to Claude for the face check. */
  face_frames: 6,
  /** Every frame must show exactly one face; this many must show it clearly. */
  min_clear_face_frames: 5,
} as const;

/** Gate 2: Pronunciation prep. */
export const PRONUNCIATION_PREP = {
  /** At most this many unknown risky words go to Claude (FAST) per script. */
  max_suggestions_per_script: 10,
} as const;
