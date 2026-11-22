import "server-only";
import type { PronunciationEntry } from "@/lib/pronunciation/dictionary";
import { z } from "zod";
import { PlainError } from "@/lib/plain-error";
import { OVERRIDE_HAS_VIDEO } from "@/lib/qa/script-override";
import { SCRIPT_REWRITE_CLOSED, type FinishChecksOutcome, type ScriptQaStore } from "@/lib/qa/script-pipeline";
import { createAdminClient } from "@/lib/supabase/admin";

// The QA gates' database reads and writes, with the secret key. Call only
// after requireAdmin() (admin actions) or from trusted background jobs.

/** Postgres "unique_violation": the word is already in the brand's list. */
const UNIQUE_VIOLATION = "23505";

const scriptVersionAnswer = z.object({
  outcome: z.enum(["inserted", "overridden", "closed", "has_video", "not_found"]),
  script_id: z.string().nullable(),
});

/** The insert_script_version answer → the new script id, or a plain refusal. */
export function scriptVersionResult(data: unknown): string {
  const parsed = scriptVersionAnswer.safeParse(data);
  if (!parsed.success) throw new Error("Could not save script version: unexpected answer");
  const { outcome, script_id } = parsed.data;
  if (outcome === "closed") throw new PlainError(SCRIPT_REWRITE_CLOSED);
  if (outcome === "has_video") throw new PlainError(OVERRIDE_HAS_VIDEO);
  if (outcome === "not_found" || !script_id) throw new PlainError("Post not found.");
  return script_id;
}

const finishAnswer = z.object({ outcome: z.enum(["done", "stale", "moved_on", "not_found"]) });

/** The finish_script_checks answer (migration 20261122230000) → its outcome. */
export function scriptChecksFinishResult(data: unknown): FinishChecksOutcome {
  const parsed = finishAnswer.safeParse(data);
  if (!parsed.success) throw new Error("Could not save the script check result: unexpected answer");
  return parsed.data.outcome;
}

export function createQaStore(): ScriptQaStore {
  const db = createAdminClient();
  return {
    async insertQaReport(row) {
      const { error } = await db.from("qa_reports").insert(row);
      if (error) throw new Error(`Could not save QA report: ${error.message}`);
    },
    async insertScriptVersion(row, override) {
      // p5-a: rpc insert_script_version (post row locked; no rewrite after scripting unless an
      // audited admin override). Migration 20261122210000.
      const { data, error } = await db.rpc("insert_script_version", {
        p_row: row,
        p_override_by: override?.by ?? null,
        p_override_reason: override?.reason ?? null,
      });
      if (error) throw new Error(`Could not save script version: ${error.message}`);
      return scriptVersionResult(data);
    },
    async updateScript(id, patch) {
      const { error } = await db.from("scripts").update(patch).eq("id", id);
      if (error) throw new Error(`Could not update script: ${error.message}`);
    },
    async finishChecks(scriptId, patch) {
      // p5-b1 (Rowan 7): rpc finish_script_checks (post row locked). Only the LATEST version sets its
      // qa_status and moves the post; only posts still being scripted move on.
      const { data, error } = await db.rpc("finish_script_checks", {
        p_script_id: scriptId,
        p_qa_status: patch.qa_status,
        p_post_status: patch.status,
        p_status_reason: patch.status_reason,
      });
      if (error) throw new Error(`Could not save the script check result: ${error.message}`);
      return scriptChecksFinishResult(data);
    },
    async getRewriteState(postId) {
      // p5-b1 (Rowan 5): the same facts insert_script_version decides on (migration 20261122210000):
      // the post's status and an active post video (kind post, not failed / skipped). Read only.
      const { data: post, error } = await db.from("posts").select("status").eq("id", postId).maybeSingle();
      if (error) throw new Error(`Could not load post: ${error.message}`);
      if (!post) return null;
      const { count, error: videoError } = await db
        .from("videos")
        .select("id", { count: "exact", head: true })
        .eq("post_id", postId)
        .eq("kind", "post")
        .not("status", "in", "(failed,skipped)");
      if (videoError) throw new Error(`Could not check the post's videos: ${videoError.message}`);
      return { status: post.status as string, hasActiveVideo: (count ?? 0) > 0 };
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
