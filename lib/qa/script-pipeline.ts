// The script checks after the writer: Gate 1 (Script QA, one rewrite) then
// Gate 2 (Pronunciation prep). docs/QA-SPEC.md.
//
// Everything that touches the database goes through a ScriptQaStore, so the
// same code runs against Supabase (lib/qa/store.ts), in unit tests and in the
// golden set (tests/helpers/memory-store.ts). Claude calls go through `run`
// (runClaudeTask in the app, mock answers in tests).
//
// Where the post goes (confirmed by the owner):
// - both gates pass: managed brands and "Review everything" brands →
//   script_review (someone reads the script); everyone else → approved.
// - Gate 1 fails after its one rewrite: managed → team_review (team queue);
//   self-serve → needs_you with a plain reason.
import type { ScriptOutput } from "@/lib/ai-schemas";
import { ClaudeError, type ClaudeBrand, type ClaudeContext, type ClaudeTaskName, type TaskOutput } from "@/lib/claude";
import { PlainError } from "@/lib/plain-error";
import { buildSpokenText, type PronunciationEntry } from "@/lib/pronunciation/dictionary";
import { unspeakableCharacters } from "@/lib/pronunciation/normalise";
import { findRiskyWords } from "@/lib/pronunciation/risky-words";
import { SCRIPT_QA } from "@/lib/qa/config";
import { judgeScript, type QaIssue } from "@/lib/qa/script-checks";
import { estimateSeconds } from "@/lib/scripts";

export type QaStatus = "pending" | "passed" | "failed" | "team_review";

/** A scripts row as the gates see it. */
export type StoredScript = ScriptOutput & {
  id: string;
  post_id: string;
  version: number;
  est_seconds: number;
  qa_status: QaStatus;
  spoken_text: string | null;
};

/** One qa_reports row written by a script gate. */
export type QaReportRow = {
  script_id: string;
  gate: "script" | "pronunciation_prep";
  passed: boolean;
  score: number | null;
  issues: QaIssue[];
  auto_fix: string | null;
};

export type PostStatus = "script_review" | "approved" | "team_review" | "needs_you";

/** p5-b1: the finish_script_checks answer. */
export type FinishChecksOutcome = "done" | "stale" | "moved_on" | "not_found";

/** p5-a: a post may get a new script version only while it is in one of these. */
export const OPEN_POST_STATUSES = ["planned", "scripting"] as const;
export const isOpenPostStatus = (status: string) => (OPEN_POST_STATUSES as readonly string[]).includes(status);

/** p5-a: a rewrite was refused because the post has moved on (admin wording). */
export const SCRIPT_REWRITE_CLOSED =
  "This post has moved past scripting, so its script can't be rewritten. An admin can use “Rewrite anyway”.";

/** p5-a: who overrides the "no rewrite after scripting" rule, and why (saved on the audit row). */
export type ScriptOverride = { by: string; reason: string };

export interface ScriptQaStore {
  insertQaReport(row: QaReportRow): Promise<void>;
  /**
   * Saves a new scripts version and returns its id. p5-a: only while the post is planned or
   * scripting (rpc insert_script_version, post row locked); otherwise a PlainError
   * (SCRIPT_REWRITE_CLOSED). With `override` (admin only, after requireAdmin) it saves anyway,
   * moves the post back to scripting and writes an audit row; refused while the post has an
   * active video.
   */
  insertScriptVersion(row: Omit<StoredScript, "id">, override?: ScriptOverride): Promise<string>;
  updateScript(id: string, patch: Partial<Pick<StoredScript, "qa_status" | "spoken_text">>): Promise<void>;
  /**
   * p5-b1 (Rowan 7): the checks' verdict for one script (rpc finish_script_checks, post row
   * locked). Only the post's LATEST version may set its qa_status (when given) and move the post
   * (and only while it is planned / scripting). 'stale' = a newer version exists: nothing written.
   */
  finishChecks(
    scriptId: string,
    patch: { qa_status: QaStatus | null; status: PostStatus; status_reason: string | null },
  ): Promise<FinishChecksOutcome>;
  /**
   * p5-b1 (Rowan 5): the facts insert_script_version decides on, read cheaply BEFORE a Claude
   * rewrite (the post's status; whether it has an active post video = kind post, not failed or
   * skipped). null = no such post. The rpc still decides (post row locked); this only saves a call.
   */
  getRewriteState(postId: string): Promise<{ status: string; hasActiveVideo: boolean } | null>;
  listPronunciations(brandId: string): Promise<PronunciationEntry[]>;
  /** Saves new status 'suggested', source 'qa' rows; words already in the list are skipped. */
  insertSuggestedPronunciations(brandId: string, rows: { written: string; say_as: string }[]): Promise<void>;
}

/** The brand fields the gates need (a public.brands row fits). */
export type QaBrand = ClaudeBrand & { is_managed: boolean; autopilot_level: string };

/** Runs one Claude task: runClaudeTask in the app, a mock in tests. */
export type RunTask = <T extends ClaudeTaskName>(task: T, ctx: ClaudeContext<T>) => Promise<TaskOutput<T>>;

const SCRIPT_FIELDS = [
  "hook",
  "body",
  "cta",
  "display_text",
  "captions",
  "hashtags",
  "broll_keywords",
  "edit_plan",
] as const satisfies readonly (keyof ScriptOutput)[];

export function scriptOnly(script: ScriptOutput): ScriptOutput {
  return Object.fromEntries(SCRIPT_FIELDS.map((key) => [key, script[key]])) as ScriptOutput;
}

// ---------------------------------------------------------------------------
// Where the post goes
// ---------------------------------------------------------------------------

export function postStatusAfterChecks(brand: Pick<QaBrand, "is_managed" | "autopilot_level">): PostStatus {
  return brand.is_managed || brand.autopilot_level === "review_everything" ? "script_review" : "approved";
}

/** Customer words for each problem (never codes, seconds or "QA"). */
const PLAIN_PROBLEMS: Record<string, string> = {
  length: "it's too long",
  hook_length: "the opening line needs work",
  hook: "the opening line needs work",
  cta_missing: "the ending should point to your offer",
  cta: "the ending should point to your offer",
  banned_word: "it used a word you asked us to avoid",
  made_up_fact: "it mentioned a fact we couldn't check",
  risky_claim: "a health, money or legal claim needs softening",
  language: "it mixed languages",
  platform: "something in it may break social media rules",
  unspeakable: "some words couldn't be prepared for the voice",
};

function plainList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "something needs a closer look";
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/** What happens to a script that still fails after its one automatic fix. */
export function routeFailedScript(
  brand: Pick<QaBrand, "is_managed">,
  issues: QaIssue[],
  teamNote = "Script QA failed after one rewrite",
): { qa_status: QaStatus; post_status: PostStatus; reason: string } {
  const hardCodes = [...new Set(issues.filter((i) => i.severity === "hard").map((i) => i.code))];
  if (brand.is_managed) {
    return { qa_status: "team_review", post_status: "team_review", reason: `${teamNote}: ${hardCodes.join(", ")}.` };
  }
  const problems = [...new Set(hardCodes.map((code) => PLAIN_PROBLEMS[code] ?? "something needs a closer look"))];
  return {
    qa_status: "failed",
    post_status: "needs_you",
    reason: `We couldn't get this script right on our own: ${plainList(problems)}. Please take a look.`,
  };
}

// ---------------------------------------------------------------------------
// Gate 1: Script QA
// ---------------------------------------------------------------------------

type GateArgs = { brand: QaBrand; script: StoredScript; maxSeconds: number; run: RunTask; store: ScriptQaStore };

export type Gate1Result = { passed: boolean; script: StoredScript; issues: QaIssue[] };

async function checkOnce(args: GateArgs, script: StoredScript, autoFix: string | null) {
  const rubric = await args.run("script_qa", {
    brand: args.brand,
    input: {
      script: { hook: script.hook, body: script.body, cta: script.cta, display_text: script.display_text },
      max_seconds: args.maxSeconds,
    },
  });
  const verdict = judgeScript(
    script,
    {
      bannedWords: args.brand.banned_words,
      wordsPerSecond: Number(args.brand.words_per_second),
      maxSeconds: args.maxSeconds,
    },
    rubric,
  );
  await args.store.insertQaReport({
    script_id: script.id,
    gate: "script",
    passed: verdict.passed,
    score: verdict.score,
    issues: verdict.issues,
    auto_fix: autoFix,
  });
  return verdict;
}

/**
 * Checks a pending script. On a fail, Claude rewrites it ONCE using the
 * issues, we save the rewrite as the next version and check that. A script
 * that is already a rewrite (version 2+) is never rewritten again.
 * Leaves the failing last version for the caller to route (runScriptChecks).
 */
export async function runGate1(args: GateArgs): Promise<Gate1Result> {
  const first = await checkOnce(args, args.script, null);
  if (first.passed) {
    await args.store.updateScript(args.script.id, { qa_status: "passed" });
    return { passed: true, script: { ...args.script, qa_status: "passed" }, issues: first.issues };
  }

  const rewritesLeft = SCRIPT_QA.max_rewrites - (args.script.version - 1);
  if (rewritesLeft <= 0) return { passed: false, script: args.script, issues: first.issues };

  // p5-b1 (Rowan 5): the database would refuse the new version once the post has left scripting
  // (rpc insert_script_version 'closed'): refuse now, before paying for the Claude rewrite.
  const state = await args.store.getRewriteState(args.script.post_id);
  if (!state) throw new PlainError("Post not found.");
  if (!isOpenPostStatus(state.status)) throw new PlainError(SCRIPT_REWRITE_CLOSED);

  // Version 1 stays "pending" until the rewrite is saved: if the rewrite
  // throws (busy, timeout, bad output), "Run checks" can simply try again
  // (lib/qa/can-run-checks.ts).
  const wps = Number(args.brand.words_per_second);
  const rewritten = await args.run("script_rewrite", {
    brand: args.brand,
    input: {
      script: scriptOnly(args.script),
      issues: first.issues.map(({ code, detail }) => ({ code, detail })),
      max_seconds: args.maxSeconds,
      words_per_second: wps,
    },
  });
  const next: Omit<StoredScript, "id"> = {
    ...scriptOnly(rewritten),
    post_id: args.script.post_id,
    version: args.script.version + 1,
    est_seconds: estimateSeconds(rewritten.display_text, wps),
    qa_status: "pending",
    spoken_text: null,
  };
  const id = await args.store.insertScriptVersion(next);
  // Now the pending rewrite is the latest version, so marking this one failed can't strand the post.
  await args.store.updateScript(args.script.id, { qa_status: "failed" });
  const fixed = [...new Set(first.issues.filter((i) => i.severity === "hard").map((i) => i.code))];
  const autoFix = `Rewrote once (version ${next.version}) to fix: ${fixed.join(", ")}.`;
  const second = await checkOnce(args, { ...next, id }, autoFix);
  if (second.passed) {
    await args.store.updateScript(id, { qa_status: "passed" });
    return { passed: true, script: { ...next, id, qa_status: "passed" }, issues: second.issues };
  }
  return { passed: false, script: { ...next, id }, issues: second.issues };
}

// ---------------------------------------------------------------------------
// Gate 2: Pronunciation prep
// ---------------------------------------------------------------------------

export type Gate2Result = { passed: boolean; spokenText: string; issues: QaIssue[] };

/**
 * Builds spoken_text from display_text (approved dictionary entries, then the
 * normaliser) and saves it on the script. Unknown risky words go to Claude
 * (FAST) and come back as "suggested" dictionary rows, which are NOT used
 * until someone approves them. Fails only when spoken_text still has
 * something a voice can't read; a failed suggestion call is just a note.
 */
export async function runGate2(args: {
  brand: QaBrand;
  script: StoredScript;
  run: RunTask;
  store: ScriptQaStore;
}): Promise<Gate2Result> {
  const { brand, script, store } = args;
  const entries = brand.id ? await store.listPronunciations(brand.id) : [];
  const spokenText = buildSpokenText(script.display_text, entries);
  const issues: QaIssue[] = [];

  const risky = findRiskyWords(script.display_text, { brandName: brand.name, known: entries.map((e) => e.written) });
  if (risky.length > 0) {
    try {
      const answer = await args.run("pronunciation_suggest", { brand, input: { words: risky } });
      const asked = new Set(risky.map((w) => w.toLowerCase()));
      const suggestions = answer.suggestions
        .map((s) => ({ written: s.written.trim(), say_as: s.say_as.trim() }))
        .filter((s) => asked.has(s.written.toLowerCase()) && s.say_as);
      if (brand.id && suggestions.length > 0) await store.insertSuggestedPronunciations(brand.id, suggestions);
      for (const s of suggestions) {
        issues.push({
          code: "new_word",
          detail: `"${s.written}" has no approved pronunciation yet; suggested "${s.say_as}". Approve it in How to say names.`,
          at_seconds: null,
          severity: "soft",
        });
      }
    } catch (error) {
      if (!(error instanceof ClaudeError)) throw error;
      issues.push({
        code: "suggest_failed",
        detail: `Couldn't suggest how to say: ${risky.join(", ")} (${error.message}) Add them in How to say names.`,
        at_seconds: null,
        severity: "soft",
      });
    }
  }

  const unspeakable = unspeakableCharacters(spokenText);
  if (unspeakable.length > 0) {
    issues.unshift({
      code: "unspeakable",
      detail: `The spoken text still has ${unspeakable.map((c) => `"${c}"`).join(", ")}. Reword the script or add a dictionary entry.`,
      at_seconds: null,
      severity: "hard",
    });
  }

  const passed = unspeakable.length === 0;
  await store.updateScript(script.id, { spoken_text: spokenText });
  await store.insertQaReport({
    script_id: script.id,
    gate: "pronunciation_prep",
    passed,
    score: null,
    issues,
    auto_fix: null,
  });
  return { passed, spokenText, issues };
}

// ---------------------------------------------------------------------------
// Both gates
// ---------------------------------------------------------------------------

export type ScriptChecksResult = {
  /** p5-b1: 'superseded' = a newer script version exists; this run's verdict moved nothing. */
  outcome: PostStatus | "superseded";
  script: StoredScript;
};

/**
 * Gate 1 then Gate 2 for one script, and moves the post on. Safe to run
 * again: a pending script starts at Gate 1; a passed script without
 * spoken_text goes straight to Gate 2.
 */
export async function runScriptChecks(args: {
  brand: QaBrand;
  postId: string;
  script: StoredScript;
  maxSeconds: number;
  run: RunTask;
  store: ScriptQaStore;
}): Promise<ScriptChecksResult> {
  let script = args.script;
  if (script.qa_status === "pending") {
    const gate1 = await runGate1(args);
    script = gate1.script;
    if (!gate1.passed) return fail(args, script, gate1.issues, "Script QA failed after one rewrite");
  } else if (script.qa_status !== "passed") {
    throw new Error(`Script ${script.id} is ${script.qa_status}; only pending or passed scripts can be checked.`);
  }

  const gate2 = await runGate2({ brand: args.brand, script, run: args.run, store: args.store });
  script = { ...script, spoken_text: gate2.spokenText };
  if (!gate2.passed) return fail(args, script, gate2.issues, "Pronunciation prep failed");

  const status = postStatusAfterChecks(args.brand);
  // p5-b1 (Rowan 7): only the post's latest version may move it on (rpc finish_script_checks).
  const finished = await args.store.finishChecks(script.id, { qa_status: null, status, status_reason: null });
  if (finished === "stale") return { outcome: "superseded", script };
  return { outcome: status, script };
}

async function fail(
  args: { brand: QaBrand; postId: string; store: ScriptQaStore },
  script: StoredScript,
  issues: QaIssue[],
  teamNote: string,
): Promise<ScriptChecksResult> {
  const route = routeFailedScript(args.brand, issues, teamNote);
  // p5-b1 (Rowan 7): a newer version exists → nothing is written (not this row, not the post).
  const finished = await args.store.finishChecks(script.id, { qa_status: route.qa_status, status: route.post_status, status_reason: route.reason });
  if (finished === "stale") return { outcome: "superseded", script };
  return { outcome: route.post_status, script: { ...script, qa_status: route.qa_status } };
}
