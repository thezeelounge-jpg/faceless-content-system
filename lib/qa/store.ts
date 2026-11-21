import "server-only";
import type { PronunciationEntry } from "@/lib/pronunciation/dictionary";
import type { ScriptQaStore } from "@/lib/qa/script-pipeline";
import { createAdminClient } from "@/lib/supabase/admin";

// The QA gates' database reads and writes, with the secret key. Call only
// after requireAdmin() (admin actions) or from trusted background jobs.

/** Postgres "unique_violation": the word is already in the brand's list. */
const UNIQUE_VIOLATION = "23505";

export function createQaStore(): ScriptQaStore {
  const db = createAdminClient();
  return {
    async insertQaReport(row) {
      const { error } = await db.from("qa_reports").insert(row);
      if (error) throw new Error(`Could not save QA report: ${error.message}`);
    },
    async insertScriptVersion(row) {
      const { data, error } = await db.from("scripts").insert(row).select("id").single();
      if (error) throw new Error(`Could not save script version: ${error.message}`);
      return (data as { id: string }).id;
    },
    async updateScript(id, patch) {
      const { error } = await db.from("scripts").update(patch).eq("id", id);
      if (error) throw new Error(`Could not update script: ${error.message}`);
    },
    async updatePost(id, patch) {
      // Only posts still being scripted move on; never touch a post that is further along.
      const { error } = await db.from("posts").update(patch).eq("id", id).in("status", ["planned", "scripting"]);
      if (error) throw new Error(`Could not update post: ${error.message}`);
    },
    async listPronunciations(brandId) {
      const { data, error } = await db
        .from("pronunciations")
        .select("written, say_as, status")
        .eq("brand_id", brandId)
        .limit(1000);
      if (error) throw new Error(`Could not load pronunciations: ${error.message}`);
      return (data ?? []) as PronunciationEntry[];
    },
    async insertSuggestedPronunciations(brandId, rows) {
      // One row at a time so a word added meanwhile (unique per brand, any case) doesn't block the others.
      for (const row of rows) {
        const { error } = await db
          .from("pronunciations")
          .insert({ brand_id: brandId, written: row.written, say_as: row.say_as, status: "suggested", source: "qa" });
        if (error && error.code !== UNIQUE_VIOLATION) throw new Error(`Could not save suggested pronunciation: ${error.message}`);
      }
    },
  };
}
