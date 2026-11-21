import "server-only";
import { PlainError } from "@/lib/plain-error";
import { createAdminClient } from "@/lib/supabase/admin";

// "How to say names" rows (public.pronunciations) for the admin area. Uses the
// secret key, so call these only after requireAdmin(). Every write is limited
// to the brand in the URL, so an id from another brand never matches.

export type PronunciationRow = {
  id: string;
  written: string;
  say_as: string;
  status: "suggested" | "approved";
  source: "manual" | "qa";
  created_at: string;
};

const UNIQUE_VIOLATION = "23505";
const duplicate = (written: string) => new PlainError(`“${written}” is already in the list. Edit it below instead.`);

/** Suggested first (they need a decision), then A to Z. */
export async function listPronunciations(brandId: string): Promise<PronunciationRow[]> {
  const { data, error } = await createAdminClient()
    .from("pronunciations")
    .select("id, written, say_as, status, source, created_at")
    .eq("brand_id", brandId)
    .order("status", { ascending: false })
    .order("written", { ascending: true })
    .limit(500);
  if (error) throw new Error(`Could not load pronunciations: ${error.message}`);
  return (data ?? []) as PronunciationRow[];
}

/** An entry typed by the operator: approved at once (they are the approver). */
export async function addPronunciation(brandId: string, entry: { written: string; say_as: string }): Promise<void> {
  const { error } = await createAdminClient()
    .from("pronunciations")
    .insert({ brand_id: brandId, ...entry, status: "approved", source: "manual" });
  if (error?.code === UNIQUE_VIOLATION) throw duplicate(entry.written);
  if (error) throw new Error(`Could not save pronunciation: ${error.message}`);
}

/** Returns false when no entry with this id belongs to the brand. */
export async function approvePronunciation(brandId: string, id: string): Promise<boolean> {
  const { data, error } = await createAdminClient()
    .from("pronunciations")
    .update({ status: "approved" })
    .eq("id", id)
    .eq("brand_id", brandId)
    .select("id");
  if (error) throw new Error(`Could not approve pronunciation: ${error.message}`);
  return (data ?? []).length > 0;
}

/** Changes the spelling and say-as (status stays). Returns false when nothing matched. */
export async function updatePronunciation(
  brandId: string,
  id: string,
  entry: { written: string; say_as: string },
): Promise<boolean> {
  const { data, error } = await createAdminClient()
    .from("pronunciations")
    .update(entry)
    .eq("id", id)
    .eq("brand_id", brandId)
    .select("id");
  if (error?.code === UNIQUE_VIOLATION) throw duplicate(entry.written);
  if (error) throw new Error(`Could not update pronunciation: ${error.message}`);
  return (data ?? []).length > 0;
}
