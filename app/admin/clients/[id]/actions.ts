"use server";

import { revalidatePath } from "next/cache";
import { logAdminError, plainAdminMessage } from "@/lib/admin-errors";
import { requireAdmin } from "@/lib/auth";
import { getBrand } from "@/lib/brands";
import { profileFromFormData, profileProblem, saveBrandVersion, type ProfileActionState } from "@/lib/brand-versions";
import { runClaudeTask } from "@/lib/claude";
import { createAdminClient } from "@/lib/supabase/admin";

const NOT_FOUND: ProfileActionState = { status: "error", message: "Client not found." };

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
