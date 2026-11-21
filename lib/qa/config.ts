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

/** Gate 2: Pronunciation prep. */
export const PRONUNCIATION_PREP = {
  /** At most this many unknown risky words go to Claude (FAST) per script. */
  max_suggestions_per_script: 10,
} as const;
