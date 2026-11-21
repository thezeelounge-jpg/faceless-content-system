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
} from "@/lib/posts";
import { runScriptChecks, type PostStatus } from "@/lib/qa/script-pipeline";
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
const CHECK_OUTCOME: Record<PostStatus, string> = {
  script_review: "Checked: ready for script review.",
  approved: "Checked and approved.",
  team_review: "It failed the checks after one rewrite and is in the team queue.",
  needs_you: "It failed the checks after one rewrite; the client sees “Needs you”.",
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

/** "Run checks": Gates 1 and 2 for a script still pending (or passed but without spoken_text). */
export async function checkScript(scriptId: string, _prev: ActionState): Promise<ActionState> {
  await requireAdmin();
  try {
    const found = await getScriptForChecks(scriptId);
    if (!found) return { status: "error", message: "Script not found." };
    const { script, post } = found;
    const runnable = script.qa_status === "pending" || (script.qa_status === "passed" && !script.spoken_text);
    if (!runnable) return { status: "error", message: "This script has already been checked." };
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
    return {
      status: "error",
      message: plainAdminMessage(error, "Couldn't run the checks. Please try again in a minute."),
    };
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
