"use server";

import { revalidatePath } from "next/cache";
import { logAdminError, plainAdminMessage } from "@/lib/admin-errors";
import { requireAdmin } from "@/lib/auth";
import { getBrand } from "@/lib/brands";
import { profileFromFormData, profileProblem, saveBrandVersion, type ProfileActionState } from "@/lib/brand-versions";
import { runClaudeTask } from "@/lib/claude";
import type { ActionState } from "@/lib/plain-error";
import { createMonthlyPlan, planStartDate } from "@/lib/planner";
import { localDateString, timezoneFor } from "@/lib/posting-times";
import {
  getOwnerPlan,
  getPost,
  getScriptForChecks,
  insertPosts,
  lastPlannedDate,
  loadPlanSettings,
  saveFirstScript,
  savePostProblem,
} from "@/lib/posts";
import { canRunChecks, latestScript } from "@/lib/qa/can-run-checks";
import { rewriteAnywayInput, rewriteScriptAnyway } from "@/lib/qa/script-override";
import { runScriptChecks, type ScriptChecksResult } from "@/lib/qa/script-pipeline";
import { createQaStore } from "@/lib/qa/store";
import { maxSecondsFor, writeScriptForPost } from "@/lib/scripts";
import { createAdminClient } from "@/lib/supabase/admin";

const NOT_FOUND = { status: "error", message: "Client not found." } as const satisfies ActionState;

/** "Write profile": Claude (MAIN) writes profile_md and 4 to 6 pillars, saved as a new version. */
export async function generateBrandProfile(brandId: string, _prev: ProfileActionState): Promise<ProfileActionState> {
  await requireAdmin();
  try {
    const brand = await getBrand(brandId);
    if (!brand) return NOT_FOUND;
    const profile = await runClaudeTask("brand_profile", { brand, input: {} });
    const version = await saveBrandVersion(createAdminClient(), brand.id, profile, "generated");
    revalidatePath(`/admin/clients/${brand.id}`);
    return { status: "ok", message: `Profile version ${version} saved.` };
  } catch (error) {
    logAdminError("[admin] write profile failed", { brandId }, error);
    return {
      status: "error",
      message: plainAdminMessage(error, "Couldn't write the profile. Please try again in a minute."),
    };
  }
}

/** "Plan next 4 weeks": our code picks the slots, Claude (PLANNER) fills them, we save planned posts. */
export async function planNextFourWeeks(brandId: string, _prev: ActionState): Promise<ActionState> {
  await requireAdmin();
  try {
    const brand = await getBrand(brandId);
    if (!brand) return NOT_FOUND;
    const timezone = timezoneFor(brand.audience_countries);
    const [settings, lastDate] = await Promise.all([loadPlanSettings(), lastPlannedDate(brand.id, timezone)]);
    const startDate = planStartDate(localDateString(new Date(), timezone), lastDate);
    const rows = await createMonthlyPlan({
      brand,
      startDate,
      settings,
      runPlan: (ctx) => runClaudeTask("plan", ctx),
    });
    await insertPosts(rows);
    revalidatePath(`/admin/clients/${brand.id}`);
    const first = shortDate(localDateString(new Date(rows[0].scheduled_for), timezone));
    const last = shortDate(localDateString(new Date(rows[rows.length - 1].scheduled_for), timezone));
    return { status: "ok", message: `Planned ${rows.length} posts from ${first} to ${last}.` };
  } catch (error) {
    logAdminError("[admin] plan failed", { brandId }, error);
    return {
      status: "error",
      message: plainAdminMessage(error, "Couldn't plan the next 4 weeks. Please try again in a minute."),
    };
  }
}

/** One sentence for where the post went after the checks. */
const CHECK_OUTCOME: Record<ScriptChecksResult["outcome"], string> = {
  script_review: "Checked: ready for script review.",
  approved: "Checked and approved.",
  team_review: "It failed the checks after one rewrite and is in the team queue.",
  needs_you: "It failed the checks after one rewrite; the client sees “Needs you”.",
  // p5-b1 (Rowan 7): a newer version of the script exists; it is checked on its own.
  superseded: "A newer version of this script exists, so this check changed nothing. Reload the page.",
};

/** "Write script" for one planned post: Claude (MAIN) writes it, our code checks the length, we save version 1, then Gates 1 and 2 run. */
export async function writeScript(postId: string, _prev: ActionState): Promise<ActionState> {
  await requireAdmin();
  let written: string | null = null;
  try {
    const post = await getPost(postId);
    if (!post) return { status: "error", message: "Post not found." };
    if (post.status !== "planned") return { status: "error", message: "This post already has a script." };
    const brand = await getBrand(post.brand_id);
    if (!brand) return NOT_FOUND;
    const maxSeconds = maxSecondsFor(await getOwnerPlan(brand.owner_id));
    const row = await writeScriptForPost({
      brand,
      post,
      maxSeconds,
      runScript: (ctx) => runClaudeTask("script", ctx),
    });
    const id = await saveFirstScript(row);
    written = `Script written (about ${Math.round(row.est_seconds)} seconds).`;
    revalidatePath(`/admin/clients/${brand.id}`);
    const checks = await runScriptChecks({
      brand,
      postId: post.id,
      script: { ...row, id, spoken_text: null },
      maxSeconds,
      run: runClaudeTask,
      store: createQaStore(),
    });
    revalidatePath(`/admin/clients/${brand.id}`);
    return { status: "ok", message: `${written} ${CHECK_OUTCOME[checks.outcome]}` };
  } catch (error) {
    logAdminError(written ? "[admin] script checks failed" : "[admin] write script failed", { postId }, error);
    await saveProblem(postId, written ? CHECKS_UNFINISHED_AFTER_WRITE : WRITE_FAILED);
    if (written) {
      const why = plainAdminMessage(error, "something went wrong.");
      return { status: "error", message: `Script written, but the checks didn't finish: ${why} Press “Run checks” to try again.` };
    }
    return {
      status: "error",
      message: plainAdminMessage(error, "Couldn't write the script. Please try again in a minute."),
    };
  }
}

/** Plain sentences saved on the post (status_reason) when an action stops half-way. Never provider text. */
const WRITE_FAILED = "Couldn't write the script. Press “Write script” to try again.";
const CHECKS_UNFINISHED_AFTER_WRITE = "Script written, but the checks didn't finish. Press “Run checks” to try again.";
const CHECKS_UNFINISHED = "The checks didn't finish. Press “Run checks” to try again.";
const STALE_VERSION = "A newer version of this script exists, so refresh the page and check that one.";

/** Saves the problem on the post; if even that fails, only log it (the admin still gets the plain message). */
async function saveProblem(postId: string, reason: string): Promise<void> {
  try {
    await savePostProblem(postId, reason);
  } catch (error) {
    logAdminError("[admin] saving the post's problem failed", { postId }, error);
  }
}

/** "Run checks": Gates 1 and 2 when canRunChecks says the post's latest script needs them (same rule as the page). */
export async function checkScript(scriptId: string, _prev: ActionState): Promise<ActionState> {
  await requireAdmin();
  let postId: string | null = null;
  try {
    const found = await getScriptForChecks(scriptId);
    if (!found) return { status: "error", message: "Script not found." };
    const { script, post, versions } = found;
    // A stale tab may submit an older version: point the admin at the newer one.
    if (latestScript(versions)?.id !== script.id) return { status: "error", message: STALE_VERSION };
    if (!canRunChecks(versions, post)) return { status: "error", message: "This script has already been checked." };
    postId = post.id;
    const brand = await getBrand(post.brand_id);
    if (!brand) return NOT_FOUND;
    const maxSeconds = maxSecondsFor(await getOwnerPlan(brand.owner_id));
    const checks = await runScriptChecks({
      brand,
      postId: post.id,
      script,
      maxSeconds,
      run: runClaudeTask,
      store: createQaStore(),
    });
    revalidatePath(`/admin/clients/${brand.id}`);
    return { status: "ok", message: CHECK_OUTCOME[checks.outcome] };
  } catch (error) {
    logAdminError("[admin] script checks failed", { scriptId }, error);
    if (postId) await saveProblem(postId, CHECKS_UNFINISHED);
    return {
      status: "error",
      message: plainAdminMessage(error, "Couldn't run the checks. Please try again in a minute."),
    };
  }
}

/**
 * p5-a "Rewrite anyway": the admin override of "no rewrite once the post has left scripting".
 * requireAdmin first; zod checks the reason + confirm box before any Claude call. The database
 * saves the new version, moves the post back to scripting and writes the audit row (who, why)
 * in one transaction (rpc insert_script_version); then Gates 1 and 2 run as usual.
 */
export async function rewriteAnyway(scriptId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const input = rewriteAnywayInput.safeParse({ reason: formData.get("reason") ?? "", confirm: formData.get("confirm") ?? "" });
  if (!input.success) return { status: "error", message: input.error.issues[0]?.message ?? "Check the form." };
  try {
    const found = await getScriptForChecks(scriptId);
    if (!found) return { status: "error", message: "Script not found." };
    const { script, post, versions } = found;
    if (latestScript(versions)?.id !== script.id) return { status: "error", message: STALE_VERSION };
    const brand = await getBrand(post.brand_id);
    if (!brand) return NOT_FOUND;
    const maxSeconds = maxSecondsFor(await getOwnerPlan(brand.owner_id));
    const checks = await rewriteScriptAnyway({
      brand,
      postId: post.id,
      postStatus: post.status,
      script,
      adminEmail: admin.email || "unknown admin",
      reason: input.data.reason,
      maxSeconds,
      run: runClaudeTask,
      store: createQaStore(),
    });
    revalidatePath(`/admin/clients/${brand.id}`);
    return { status: "ok", message: `Rewritten (version ${checks.script.version}). ${CHECK_OUTCOME[checks.outcome]}` };
  } catch (error) {
    logAdminError("[admin] rewrite anyway failed", { scriptId }, error);
    return { status: "error", message: plainAdminMessage(error, "Couldn't rewrite the script. Please try again in a minute.") };
  }
}

/** "2026-12-07" → "7 Dec". */
function shortDate(date: string): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(
    new Date(`${date}T00:00:00Z`),
  );
}

/** Saves the admin's edit of the profile and pillars as a new version. */
export async function saveProfileEdit(
  brandId: string,
  prev: ProfileActionState,
  formData: FormData,
): Promise<ProfileActionState> {
  await requireAdmin();
  const values = profileFromFormData(formData);
  const attempt = (prev.attempt ?? 0) + 1;

  const problem = profileProblem(values);
  if (problem) return { status: "error", message: problem, values, attempt };

  try {
    const brand = await getBrand(brandId);
    if (!brand) return NOT_FOUND;
    const version = await saveBrandVersion(createAdminClient(), brand.id, values, "edited");
    revalidatePath(`/admin/clients/${brand.id}`);
    return { status: "ok", message: `Profile version ${version} saved.` };
  } catch (error) {
    logAdminError("[admin] save profile failed", { brandId }, error);
    return {
      status: "error",
      message: plainAdminMessage(error, "Couldn't save the profile. Please try again in a minute."),
      values,
      attempt,
    };
  }
}
