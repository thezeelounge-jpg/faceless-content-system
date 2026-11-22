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

/**
 * Renders on HeyGen (Phase 3 part B, lib/render.ts). Not quality gates, but
 * the numbers that bound how long and how many: kept here with the others.
 */
export const RENDER = {
  /** HeyGen allows 10 videos at once on Pay-As-You-Go (docs "Usage Limits"). */
  max_concurrent: 10,
  /** When all slots are busy, the render task waits this long and tries again... */
  busy_wait_s: 60,
  /** ...at most this many times (about an hour), then leaves the video queued. */
  busy_max_waits: 60,
  /** Polling backup (webhooks are attempted once): every 30 s for up to 30 minutes. */
  poll_every_s: 30,
  poll_max_s: 1800,
  /**
   * The safe video downloader (lib/safe-download.ts, QA MUST FIX 1). 200 MB is
   * far above a 60-second 1080p/2k reel (roughly 10 to 100 MB) and equals
   * HeyGen's own direct-upload limit; the whole file sits in memory once.
   */
  download_max_bytes: 200 * 1024 * 1024,
  /** At most this many redirects; every hop is checked again (https, allowlist, DNS). */
  download_max_redirects: 3,
  /** One timeout for the whole download, body included. */
  download_timeout_s: 300,
} as const;

/**
 * The editor (Phase 4, lib/edit-flow.ts). Not a quality gate; the time limits
 * of one edit. A 60 s reel encodes in about real time on 4 vCPUs (large-1x);
 * the limit leaves room for a slow machine. The task's maxDuration is longer.
 */
export const EDIT = {
  /** ffmpeg is stopped after this long. */
  ffmpeg_timeout_s: 900,
} as const;

/**
 * brands.words_per_second: the rolling average of the last 10 real post
 * renders (words in spoken_text / real duration). Samples outside these
 * bounds are ignored as absurd (a broken duration, an empty script).
 */
export const WORDS_PER_SECOND = {
  window: 10,
  min_duration_s: 3,
  max_duration_s: 600,
  min_wps: 0.8,
  max_wps: 5,
} as const;

/**
 * Likeness test (Phase 3 item 6): one render per realistic engine the look
 * lists in supported_api_engines. HeyGen's docs give no realism ranking
 * (checked 22 Nov 2026), so this list is OUR choice: the newest full-quality
 * engines; "-turbo" (a speed variant) and avatar_iii (older) are left out.
 * Order = order on the page. The owner can change it.
 */
export const LIKENESS = {
  realistic_engines: ["heygen-avatar-6", "avatar_v", "avatar_iv"],
} as const;
