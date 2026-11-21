"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import {
  brandFieldErrors,
  brandInputFromFormData,
  brandInputSchema,
  brandInputToRow,
  type BrandFormState,
} from "@/lib/brand-input";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Admin → Clients → New client. Saves a done-for-you (managed) brand.
 * The admin who adds it is the owner until the client gets their own login (Phase 6).
 */
export async function createManagedBrand(_prev: BrandFormState, formData: FormData): Promise<BrandFormState> {
  const admin = await requireAdmin();

  const values = brandInputFromFormData(formData);
  const attempt = (_prev.attempt ?? 0) + 1;
  const parsed = brandInputSchema.safeParse(values);
  if (!parsed.success) {
    return {
      status: "error",
      message: "Please fix the answers marked below.",
      fieldErrors: brandFieldErrors(parsed.error),
      values,
      attempt,
    };
  }

  let brandId: string;
  try {
    const { data, error } = await createAdminClient()
      .from("brands")
      .insert(brandInputToRow(parsed.data, { ownerId: admin.id, isManaged: true }))
      .select("id")
      .single();
    if (error || !data) throw new Error(error?.message ?? "no row returned");
    brandId = data.id as string;
  } catch (error) {
    console.error("[admin] could not save brand:", error instanceof Error ? error.message : error);
    return {
      status: "error",
      message: "Couldn't save the client. Check that Supabase is set up, then try again.",
      values,
      attempt,
    };
  }

  revalidatePath("/admin/clients");
  redirect(`/admin/clients/${brandId}`);
}
