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
 * Waiting for a twin (lib/twin.ts pollTwinUntilReady, trigger/poll-twin.ts):
 * the first check waits first_wait_s, each next wait doubles up to max_wait_s,
 * at most max_attempts checks (about a day: HeyGen's consent link lasts 24 hours).
 */
export const TWIN_POLL = {
  first_wait_s: 60,
  max_wait_s: 1800,
  max_attempts: 60,
} as const;

/**
 * The longest the twin poll waits in total (seconds): the sum of the waits
 * between its max_attempts checks = 60+120+240+480+960 + 54 × 1800 = 99060 s
 * (about 27.5 hours). p4-b1 (Rowan 5c): a twin claim may be cleared only after
 * this long (or once the twin failed). The SQL clear_stuck_claim holds the same
 * number (tests/db/rls.test.ts checks).
 */
export const TWIN_POLL_MAX_S = Array.from({ length: TWIN_POLL.max_attempts - 1 }, (_, i) =>
  Math.min(TWIN_POLL.first_wait_s * 2 ** i, TWIN_POLL.max_wait_s),
).reduce((sum, wait) => sum + wait, 0);

/**
 * The editor (Phase 4, lib/edit-flow.ts). Not a quality gate; the time limits
 * of one edit. A 60 s reel encodes in about real time on 4 vCPUs (large-1x);
 * the limit leaves room for a slow machine. The task's maxDuration is longer.
 */
export const EDIT = {
  /** ffmpeg (the final encode) is stopped after this long. */
  ffmpeg_timeout_s: 900,
  /** p4-b2: loudness pass 1 (audio only, decodes far faster than real time). */
  loudness_timeout_s: 90,
  /** p4-b2: ffprobe for the raw video's length. */
  probe_timeout_s: 30,
  /** trigger/edit-video.ts maxDuration (seconds of compute); Trigger.dev stops the run after this. */
  task_max_duration_s: 1800,
  /**
   * p4-b1: an edit claim (videos.edit_run_id) older than this may be taken over
   * by another run. Equal to the task's maxDuration: by then the old run is stopped.
   */
  claim_stale_s: 1800,
  /**
   * p4-b1 (QA SF4): storage download / upload in the edit task. Each try is
   * stopped after storage_timeout_s; at most storage_max_attempts tries, waiting
   * storage_backoff_ms × 2^(try-1) plus up to one backoff of random jitter.
   * Worst case for download + upload + ffmpeg stays under task_max_duration_s.
   */
  storage_timeout_s: 120,
  storage_max_attempts: 3,
  storage_backoff_ms: 2000,
  /**
   * p5-a: "Clean up old edit files" removes a run's final/<brand>/<video>/runs/<run>.mp4 only
   * when the row does not point at it, the run holds no claim, and the file is older than this.
   * 6 hours: far beyond a run's life (2 attempts × task_max_duration_s plus retries), so no live
   * run can still be writing or promoting it. Not a QA threshold (a safety wait).
   */
  stray_run_min_age_s: 21_600,
  /** p5-a: the cleanup looks at this many edited videos per press (newest edits first). */
  stray_run_videos_per_pass: 200,
} as const;

/**
 * B-roll cut-ins (Phase 4 part B, lib/broll.ts planBroll). PRODUCT.md "Video
 * formats" + QA-SPEC Gate 4: each cut-in 1.5 to 3 s, 2 to 4 of them when they
 * fit, total coverage talking ≤ 25% / story ≤ 60% of the video, never during
 * the hook or the call to action (the face is on screen there).
 */
export const BROLL = {
  min_cut_s: 1.5,
  max_cut_s: 3,
  /** Wanted length of one cut-in; shortened (never below min_cut_s) to fit. */
  target_cut_s: 2.5,
  min_cuts: 2,
  max_cuts: 4,
  /** Share of the whole video that b-roll may cover, per post format. */
  max_coverage: { talking: 0.25, story: 0.6 },
  /** The face comes back for at least this long between two cut-ins. */
  min_gap_s: 0.5,
} as const;

/**
 * Music bed under the voice (lib/music.ts). Beds are prepared at about -14
 * LUFS; bed_gain_db turns them down, and sidechaincompress (the voice is the
 * sidechain) ducks them further while someone speaks. QA-SPEC Gate 4: the
 * music stem must be at least 15 dB quieter than the voice stem.
 */
export const MUSIC = {
  bed_gain_db: -22,
  fade_in_s: 0.5,
  fade_out_s: 1.5,
  /** sidechaincompress (ffmpeg 7.1 `-h filter=sidechaincompress`): threshold is linear 0.000976563..1. */
  duck: { threshold: 0.02, ratio: 8, attack_ms: 20, release_ms: 400 },
  /** QA-SPEC Gate 4. */
  min_voice_over_music_db: 15,
} as const;

/**
 * Final mix loudness (QA-SPEC Gate 4: -14 LUFS ±1.5, true peak ≤ -1 dBTP; we
 * aim stricter: ±1). Two-pass loudnorm: pass 1 measures with these targets,
 * pass 2 applies the measured values with linear=true. Target TP is -1.5 so
 * the AAC encode keeps 0.5 dB of headroom under the -1 dBTP limit.
 */
export const LOUDNESS = {
  target_i: -14,
  target_tp: -1.5,
  target_lra: 11,
  tolerance_lu: 1,
  max_true_peak_db: -1,
} as const;

/**
 * Gate 3: Audio and pronunciation QA (p5-a2, lib/qa/audio-checks.ts, lib/qa/audio-gate.ts).
 * Starting values from QA-SPEC; calibrate on the first real videos.
 */
export const AUDIO_QA = {
  /** Highest word error rate allowed, per brands.language (speech-to-text is less reliable in Roman Urdu / Hinglish). */
  max_wer: { en: 0.08, roman_urdu: 0.15, hinglish: 0.15 },
  /** Key terms (brand, person, offers, CTA words, dictionary) heard wrong after Claude's same-sound check. */
  max_key_term_mismatches: 0,
  /** The longest silence allowed inside speech (word gaps and ffmpeg silencedetect). */
  max_silence_s: 1.0,
  /** silencedetect: quieter than this counts as silence. */
  silence_noise_db: -40,
  /** The real duration may differ from scripts.est_seconds by at most this share. */
  duration_tolerance: 0.15,
  /**
   * Clipping (ffmpeg astats, whole file): the loudest sample at or above clip_peak_dbfs AND
   * reached at least clip_min_peak_count times (flat tops). A clean loud voice peaks once or twice.
   */
  clip_peak_dbfs: -0.1,
  clip_min_peak_count: 8,
  /** One automatic fix per gate: at most this many QA re-renders of a post video (SQL create_qa_rerender holds the same number). */
  max_rerenders: 1,
  /** ffmpeg measuring the raw audio is stopped after this long. */
  measure_timeout_s: 120,
} as const;

/**
 * Gate 4: Technical QA (p5-a2, lib/qa/technical-checks.ts, lib/qa/technical-gate.ts). ffprobe +
 * ffmpeg filters, no AI. The music rule reuses MUSIC.min_voice_over_music_db; b-roll reuses BROLL.
 */
export const TECH_QA = {
  width: 1080,
  height: 1920,
  fps: 30,
  video_codec: "h264",
  pix_fmt: "yuv420p",
  audio_codec: "aac",
  audio_rate: 48000,
  /** Duration ≤ plan max_seconds_per_video + this. */
  duration_slack_s: 1,
  loudness_target_lufs: -14,
  loudness_tolerance_lu: 1.5,
  max_true_peak_dbtp: -1,
  /** blackdetect: a frame darker than this share of full scale is black; reported from black_report_s, fails above max_black_s. */
  black_pix_th: 0.1,
  black_report_s: 0.1,
  max_black_s: 0.5,
  /** freezedetect: frames closer than freeze_noise_db count as the same; reported from freeze_report_s, fails above max_freeze_s. */
  freeze_noise_db: -60,
  freeze_report_s: 0.5,
  max_freeze_s: 1.5,
  /** Each caption word starts within this of its speech-to-text timing. */
  caption_timing_tolerance_s: 0.15,
  caption_max_lines: 2,
  /** Captions stay out of the top 12%, bottom 20% and right 12% of the frame. */
  safe_zone: { top: 0.12, bottom: 0.2, right: 0.12 },
  /** File size: under this many MB per 60 s of video (proportional). */
  max_mb_per_60s: 100,
  /** b-roll cut lengths are compared with this slack (ffmpeg rounds times to milliseconds). */
  broll_slack_s: 0.01,
  /** One automatic fix per gate: the edit is rebuilt at most this many times. */
  max_rebuilds: 1,
  /** ffmpeg measuring the final file is stopped after this long. */
  measure_timeout_s: 300,
} as const;

/**
 * Gate 5: Visual and realism QA (p5-b2, lib/qa/visual-checks.ts, lib/qa/visual-gate.ts). Claude (MAIN)
 * with image input on frames sampled from the final video, plus pixel checks without AI.
 */
export const VISUAL_QA = {
  /** QA-SPEC: one frame every 2 s, plus the first and last frames, plus one from each b-roll cut-in. */
  frame_every_s: 2,
  /** Never send more frames than this (a 60 s reel needs about 35). */
  max_frames: 40,
  /** Frames go to Claude as JPEGs this wide (9:16, so 960 tall); Claude downsizes larger images anyway. */
  claude_frame_width: 540,
  /** realism_score (1 to 10, "would a viewer believe this is a real recording?"): this or more passes. */
  pass_realism_score: 8,
  /** One automatic fix per gate (a re-edit or a re-render), counted per script (SQL create_visual_rerender holds the same number). */
  max_fixes: 1,
  /** Captions over the mouth / unreadable: re-edit with the first of these whose 2-line box starts lower than the current style's. */
  caption_fix_styles: ["small_box", "minimal"],
  /** Frame extraction (one ffmpeg pass over the final file) is stopped after this long. */
  extract_timeout_s: 120,
  /**
   * Pixel checks of the AI label and the trial corner tag (luma 0-255, no AI). drawtext box=1 darkens
   * what is under it by the box's alpha (black@0.55 → 0.45 × background + 0.55 × black). pad strip =
   * the box rows above the text; outside = the background just beside the box, same rows.
   * Drawn = the pad strip is within box_tolerance of the darkened outside AND at least text_min_share
   * of the text rows are at least text_min_luma. If the box could darken the background by less than
   * min_contrast (a near-black frame) the frame is "unknown" (not counted either way).
   * text_width_em = the shortest text width we expect, per px of font size per letter.
   */
  pixel: { box_tolerance: 14, min_contrast: 25, text_min_luma: 180, text_min_share: 0.02, text_width_em: 0.45 },
} as const;

/** Gate 6: which videos a person watches before the customer sees them (QA-SPEC "Gate 6: Human review"). */
export const HUMAN_REVIEW = {
  /** The first 5 videos of every new brand. */
  first_videos_per_brand: 5,
  /** Any video with realism_score below 9 (it passed Gate 5 at 8). */
  below_realism_score: 9,
  /** A random 1 in 5 of all other videos (stable per video id, so a retry decides the same). */
  random_one_in: 5,
} as const;

/**
 * p5-b3: Admin → Usage and spend → Quality (QA-SPEC "Metrics"). The targets are QA-SPEC's; the page
 * marks a metric green or red against them. Read only: nothing here changes a gate.
 */
export const QUALITY = {
  targets: {
    /** First-time pass rate, per gate: over 85%. */
    first_pass_min: 0.85,
    /** Automatic fix success rate: over 70%. */
    auto_fix_success_min: 0.7,
    /** Human reject rate: under 5%. */
    human_reject_max: 0.05,
    /** Customer redo rate: under 10%. */
    customer_redo_max: 0.1,
    /** Time from approval to Ready: under 2 hours. */
    approval_to_ready_max_h: 2,
  },
  /** "Top 5 failure codes this week": how many, and "this week" = the last 7 days of the range. */
  top_failure_codes: 5,
  top_failure_days: 7,
  /** The page's range when none is picked. */
  default_range_days: 28,
} as const;

/**
 * p5-b3: calibration (PROMPTS Phase 5 item 8, read only). The page shows each gate's scores and a
 * proposed threshold only once this many REAL videos (a non-mock, succeeded HeyGen render) exist.
 * Proposals are never written: the owner agrees, then a person edits this file.
 */
export const CALIBRATION = {
  min_real_videos: 10,
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
