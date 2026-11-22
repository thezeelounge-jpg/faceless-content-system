// p5-a: "Rewrite anyway", the admin override of the "no rewrite after scripting" rule.
//
// Normally a post gets a new script version only while it is planned or
// scripting (rpc insert_script_version, migration 20261122210000). Once it has
// moved on (script review, approved, team queue, needs you, ...), only an admin
// can ask for a fresh rewrite. The database then saves the new version, puts
// the post back to "scripting" and writes ONE audit row (provider_usage kind
// 'script_override': who, when, from which status, why) in one transaction.
// It refuses while the post has an active video (clear that first).
//
// The caller (app/admin/clients/[id]/actions.ts) runs requireAdmin() first and
// passes the admin's email. Claude is called (script_rewrite, mocked unless
// MOCK_CLAUDE=false) only after the cheap checks pass.
import { z } from "zod";
import { PlainError } from "@/lib/plain-error";
import {
  isOpenPostStatus,
  runScriptChecks,
  scriptOnly,
  type QaBrand,
  type RunTask,
  type ScriptChecksResult,
  type ScriptQaStore,
  type StoredScript,
} from "@/lib/qa/script-pipeline";
import { estimateSeconds } from "@/lib/scripts";

export const OVERRIDE_NOT_NEEDED = "This post is still being scripted. Use “Run checks” instead.";
export const OVERRIDE_HAS_VIDEO = "This post already has a video. Clear that video first, then rewrite the script.";

/** The "Rewrite anyway" form: a reason (saved on the audit row) and the confirm box. */
export const rewriteAnywayInput = z.object({
  reason: z.string().trim().min(5, "Say in a few words why.").max(300),
  confirm: z.literal("yes", { error: "Tick the box to confirm." }), // ActionForm's confirmCheck value
});

/**
 * p5-b1 (QA SF3): where the page offers "Rewrite anyway": posts past scripting with no active post
 * video. Not team_review (it often has a video; the team clears it first, then the post is offered
 * again). Same "active" rule as insert_script_version: kind post and not failed / skipped.
 */
export const REWRITE_ANYWAY_STATUSES = ["script_review", "needs_you"] as const;
const INACTIVE_VIDEO_STATUSES = ["failed", "skipped"];
export const isActivePostVideo = (v: { kind: string; status: string }) => v.kind === "post" && !INACTIVE_VIDEO_STATUSES.includes(v.status);

export function canOfferRewriteAnyway(post: { status: string; videos?: { kind: string; status: string }[] }): boolean {
  return (REWRITE_ANYWAY_STATUSES as readonly string[]).includes(post.status) && !(post.videos ?? []).some(isActivePostVideo);
}

export async function rewriteScriptAnyway(args: {
  brand: QaBrand;
  postId: string;
  postStatus: string;
  /** The post's LATEST script version (the caller checks it is the latest). */
  script: StoredScript;
  adminEmail: string;
  reason: string;
  maxSeconds: number;
  run: RunTask;
  store: ScriptQaStore;
}): Promise<ScriptChecksResult> {
  if (isOpenPostStatus(args.postStatus)) throw new PlainError(OVERRIDE_NOT_NEEDED);
  // p5-b1 (QA SF3 + Rowan 5): what insert_script_version would answer, read from the database
  // BEFORE the Claude call: still scripting → not needed; an active post video → has_video.
  const state = await args.store.getRewriteState(args.postId);
  if (!state) throw new PlainError("Post not found.");
  if (isOpenPostStatus(state.status)) throw new PlainError(OVERRIDE_NOT_NEEDED);
  if (state.hasActiveVideo) throw new PlainError(OVERRIDE_HAS_VIDEO);
  const wps = Number(args.brand.words_per_second);
  const rewritten = await args.run("script_rewrite", {
    brand: args.brand,
    input: {
      script: scriptOnly(args.script),
      issues: [{ code: "admin_rewrite", detail: args.reason }],
      max_seconds: args.maxSeconds,
      words_per_second: wps,
    },
  });
  const next: Omit<StoredScript, "id"> = {
    ...scriptOnly(rewritten),
    post_id: args.postId,
    version: args.script.version + 1,
    est_seconds: estimateSeconds(rewritten.display_text, wps),
    qa_status: "pending",
    spoken_text: null,
  };
  const id = await args.store.insertScriptVersion(next, { by: args.adminEmail, reason: args.reason });
  // The post is back in scripting: Gates 1 and 2 as usual (a version 2+ is never auto-rewritten again).
  return runScriptChecks({ brand: args.brand, postId: args.postId, script: { ...next, id }, maxSeconds: args.maxSeconds, run: args.run, store: args.store });
}
