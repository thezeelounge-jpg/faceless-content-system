// When may an admin press "Run checks"? One rule, used by the client page
// (to show the button) and by the checkScript action (to allow it), so the
// two can never disagree. Pure: no database, no Claude.
//
// The gates (lib/qa/script-pipeline.ts) leave a post in one of these states
// when something throws half-way:
// - the latest version is "pending": Gate 1 didn't finish (or the rewrite
//   was saved but not checked yet);
// - the latest version is "passed" with no spoken_text: Gate 2 didn't finish.
// Both are retryable while the post is still "planned" or "scripting" (the
// same statuses lib/qa/store.ts finishChecks / rpc finish_script_checks is allowed to move on).

type ScriptVersion = { id: string; version: number; qa_status: string; spoken_text: string | null };

const OPEN_POST_STATUSES = ["planned", "scripting"];

/** The newest version of a post's script (undefined when there is none). */
export function latestScript<T extends Pick<ScriptVersion, "version">>(scripts: readonly T[]): T | undefined {
  return [...scripts].sort((a, b) => b.version - a.version)[0];
}

/** True when the post's latest script can be (re)checked. */
export function canRunChecks(scripts: readonly ScriptVersion[], post: { status: string }): boolean {
  if (!OPEN_POST_STATUSES.includes(post.status)) return false;
  const latest = latestScript(scripts);
  if (!latest) return false;
  return latest.qa_status === "pending" || (latest.qa_status === "passed" && !latest.spoken_text);
}
