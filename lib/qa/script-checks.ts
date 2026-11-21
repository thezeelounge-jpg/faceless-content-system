// Gate 1, Script QA: the rules (pure functions, no Claude, no database).
//
// Two kinds of checks (docs/QA-SPEC.md, Gate 1):
// - OUR code measures what can be measured: length, hook word count, banned
//   words, a call to action being there.
// - Claude (MAIN) judges the rest with a rubric (lib/ai-schemas.ts
//   scriptQaOutput): hook promise/question, CTA matches offers, made-up facts,
//   risky niches, language, platform safety, and a 1-10 voice score.
//
// Hard checks fail the gate. Voice match is SOFT: QA-SPEC says "pass at 7 or
// more" but marks it "soft", which we read as: a low score is recorded (as a
// soft issue and as qa_reports.score) and sent along with any rewrite, but it
// never fails the gate on its own. Thresholds live in lib/qa/config.ts.
import type { ScriptOutput, ScriptQaOutput } from "@/lib/ai-schemas";
import { SCRIPT_QA } from "@/lib/qa/config";
import { countWords, estimateSeconds } from "@/lib/scripts";

/** One problem found by a gate (qa_reports.issues). Scripts have no timeline, so at_seconds is null. */
export type QaIssue = {
  code: string;
  detail: string;
  at_seconds: number | null;
  severity: "hard" | "soft";
};

export type ScriptCheckOptions = {
  bannedWords: string[];
  wordsPerSecond: number;
  maxSeconds: number;
};

export type ScriptJudgement = { passed: boolean; score: number; issues: QaIssue[] };

const hard = (code: string, detail: string): QaIssue => ({ code, detail, at_seconds: null, severity: "hard" });
const soft = (code: string, detail: string): QaIssue => ({ code, detail, at_seconds: null, severity: "soft" });

/** Short words that end with a full stop but don't end a sentence. */
const ABBREVIATIONS = new Set(["dr", "mr", "mrs", "ms", "rs", "st", "vs", "no", "prof", "eg", "ie", "etc"]);

/** The first sentence: up to the first . ? or ! that isn't after an abbreviation like "Dr." or "Rs.". */
export function firstSentence(text: string): string {
  const trimmed = text.trim();
  const ends = /[.?!]+(?=\s|$)/g;
  for (const match of trimmed.matchAll(ends)) {
    const before = trimmed.slice(0, match.index);
    const lastWord = before.split(/\s+/).pop()?.replace(/\./g, "").toLowerCase() ?? "";
    if (match[0] === "." && ABBREVIATIONS.has(lastWord)) continue;
    return trimmed.slice(0, match.index + match[0].length);
  }
  return trimmed;
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A whole-word, any-case pattern (letters and digits in any script count as "word"). */
export function wholeWordPattern(phrase: string, flags = "giu"): RegExp {
  const words = phrase.trim().split(/\s+/).map(escapeRegex).join("\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}_])${words}(?![\\p{L}\\p{N}_])`, flags);
}

/** The banned words (as written on the brand) that appear in `text`. */
export function findBannedWords(text: string, banned: string[]): string[] {
  return banned.map((word) => word.trim()).filter((word) => word && wholeWordPattern(word, "iu").test(text));
}

/** Lowercase letters and digits only, single spaces: for "is the CTA in the text" checks. */
const plain = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** The checks our code makes (all hard). */
export function deterministicScriptIssues(script: ScriptOutput, opts: ScriptCheckOptions): QaIssue[] {
  const issues: QaIssue[] = [];

  const seconds = estimateSeconds(script.display_text, opts.wordsPerSecond);
  if (seconds > opts.maxSeconds) {
    const maxWords = Math.floor(opts.maxSeconds * opts.wordsPerSecond);
    issues.push(
      hard(
        "length",
        `The script has ${countWords(script.display_text)} words (about ${seconds} s); the limit is ${opts.maxSeconds} s, so cut it to ${maxWords} words or fewer.`,
      ),
    );
  }

  const hook = firstSentence(script.display_text);
  const hookWords = countWords(hook);
  if (hookWords > SCRIPT_QA.hook_max_words) {
    issues.push(
      hard(
        "hook_length",
        `The first sentence "${hook}" has ${hookWords} words; keep it to ${SCRIPT_QA.hook_max_words} or fewer.`,
      ),
    );
  }

  const allText = [script.display_text, ...Object.values(script.captions), script.hashtags.join(" ")].join("\n");
  const banned = findBannedWords(allText, opts.bannedWords);
  if (banned.length > 0) {
    issues.push(hard("banned_word", `Remove the banned word${banned.length > 1 ? "s" : ""}: ${banned.map((w) => `"${w}"`).join(", ")}.`));
  }

  const cta = plain(script.cta);
  if (!cta || !plain(script.display_text).includes(cta)) {
    issues.push(hard("cta_missing", "Add a call to action and say it in the script (display_text)."));
  }

  return issues;
}

/** Claude's rubric fields → the issue code used when that check fails. */
const RUBRIC_CHECKS = [
  ["hook_ok", "hook", "The hook should make a promise or open a question."],
  ["cta_matches_offers", "cta", "The call to action should point to one of the brand's offers."],
  ["no_made_up_facts", "made_up_fact", "Remove any number, result or claim that isn't in the brand details, or say it as an opinion."],
  ["risky_claims_softened", "risky_claim", "Soften health, money or legal claims, add a short disclaimer, and promise no results."],
  ["language_matches", "language", "Write the whole script in the brand's language."],
  ["platform_safe", "platform", "Remove anything that could break Instagram, TikTok, LinkedIn or X rules."],
] as const satisfies readonly (readonly [keyof ScriptQaOutput, string, string])[];

/** Issues from Claude's rubric: failed checks are hard, everything else (including voice) is soft. */
export function rubricScriptIssues(rubric: ScriptQaOutput): QaIssue[] {
  const issues: QaIssue[] = [];
  const failedCodes = new Set<string>();

  for (const [field, code, fallback] of RUBRIC_CHECKS) {
    if (rubric[field]) continue;
    failedCodes.add(code);
    const own = rubric.issues.filter((issue) => issue.code === code);
    if (own.length === 0) issues.push(hard(code, fallback));
    for (const issue of own) issues.push(hard(code, issue.detail));
  }

  const voiceLow = rubric.voice_score < SCRIPT_QA.voice_pass_score;
  const voiceNotes = rubric.issues.filter((issue) => issue.code === "voice");
  if (voiceLow && voiceNotes.length === 0) {
    issues.push(
      soft("voice", `Voice match is ${rubric.voice_score}/10 (pass is ${SCRIPT_QA.voice_pass_score}); make it sound more like the writing samples.`),
    );
  }

  for (const issue of rubric.issues) {
    if (failedCodes.has(issue.code)) continue;
    issues.push(soft(issue.code, issue.detail));
  }
  return issues;
}

/** The gate's verdict for one script version. */
export function judgeScript(script: ScriptOutput, opts: ScriptCheckOptions, rubric: ScriptQaOutput): ScriptJudgement {
  const issues = [...deterministicScriptIssues(script, opts), ...rubricScriptIssues(rubric)];
  return { passed: issues.every((issue) => issue.severity === "soft"), score: rubric.voice_score, issues };
}
