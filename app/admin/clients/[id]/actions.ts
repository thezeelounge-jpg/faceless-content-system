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
import { getOwnerPlan, getPost, insertPosts, lastPlannedDate, loadPlanSettings, saveFirstScript } from "@/lib/posts";
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

/** "Write script" for one planned post: Claude (MAIN) writes it, our code checks the length, we save version 1. */
export async function writeScript(postId: string, _prev: ActionState): Promise<ActionState> {
  await requireAdmin();
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
    await saveFirstScript(row);
    revalidatePath(`/admin/clients/${brand.id}`);
    return { status: "ok", message: `Script written (about ${Math.round(row.est_seconds)} seconds).` };
  } catch (error) {
    logAdminError("[admin] write script failed", { postId }, error);
    return {
      status: "error",
      message: plainAdminMessage(error, "Couldn't write the script. Please try again in a minute."),
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
