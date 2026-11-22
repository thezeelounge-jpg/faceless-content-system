import "server-only";
import { z } from "zod";
import type { PronunciationEntry } from "@/lib/pronunciation/dictionary";
import type { DeliverOutcome, GateContext, PipelineStore, RerenderOutcome } from "@/lib/qa/pipeline-types";
import { maxSecondsFor } from "@/lib/scripts";
import { createAdminClient } from "@/lib/supabase/admin";

// The video QA gates' database reads and writes (Gates 3 and 4), with the secret key.
// Server only: background jobs (trigger/*.ts) and admin code after requireAdmin().

const rerenderAnswer = z.object({
  outcome: z.enum(["created", "limit", "not_allowed", "not_found"]),
  video_id: z.string().nullable(),
});

/** The create_qa_rerender answer → { outcome, videoId }. "created" always carries the new id. */
export function rerenderResult(data: unknown): RerenderOutcome {
  const parsed = rerenderAnswer.safeParse(data);
  if (!parsed.success || (parsed.data.outcome === "created" && !parsed.data.video_id)) {
    throw new Error("Could not make the QA re-render: unexpected answer");
  }
  return { outcome: parsed.data.outcome, videoId: parsed.data.outcome === "created" ? parsed.data.video_id : null };
}

const deliverAnswer = z.object({ outcome: z.enum(["delivered", "not_allowed", "not_found"]) });

/** p5-b2: the deliver_post_video answer. */
export function deliverResult(data: unknown): DeliverOutcome {
  const parsed = deliverAnswer.safeParse(data);
  if (!parsed.success) throw new Error("Could not deliver the video: unexpected answer");
  return parsed.data.outcome;
}

/** p5-b2: distinct posts in qa_reports rows (joined videos.post_id), never `excludePostId`. */
export function distinctPosts(rows: { videos: { post_id: string | null } | null }[], excludePostId: string): number {
  const posts = new Set<string>();
  for (const row of rows) {
    const post = row.videos?.post_id;
    if (post && post !== excludePostId) posts.add(post);
  }
  return posts.size;
}

const fail = (what: string, error: { message: string }): never => {
  throw new Error(`Could not ${what}: ${error.message}`);
};
/** ilike matches the whole word in any case; %, _ and \ in a name are taken literally. */
const likeExact = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);
const UNIQUE_VIOLATION = "23505";

const VIDEO_COLUMNS =
  "id, brand_id, post_id, script_id, avatar_id, kind, status, attempt, raw_path, final_path, duration_s, transcript, ai_label, watermark, counts_toward_plan, edit_manifest, qa_fix_note, edit_run_id";
const BRAND_COLUMNS =
  "id, owner_id, name, niche, audience, offers, tone, sound_answers, samples, banned_words, language, profile_md, pillars, words_per_second, is_managed, autopilot_level";

export function createPipelineStore(): PipelineStore {
  const db = createAdminClient();
  return {
    async getGateContext(videoId) {
      const { data: video, error } = await db.from("videos").select(VIDEO_COLUMNS).eq("id", videoId).maybeSingle();
      if (error) fail("load video", error);
      if (!video?.script_id || !video.post_id) return null;
      const [script, post, brand] = await Promise.all([
        db
          .from("scripts")
          .select("id, post_id, display_text, spoken_text, hook, cta, est_seconds, edit_plan, broll_keywords")
          .eq("id", video.script_id)
          .maybeSingle(),
        db.from("posts").select("id, status, format").eq("id", video.post_id).maybeSingle(),
        db.from("brands").select(BRAND_COLUMNS).eq("id", video.brand_id).maybeSingle(),
      ]);
      for (const [what, answer] of [["script", script], ["post", post], ["brand", brand]] as const) {
        if (answer.error) fail(`load ${what}`, answer.error);
      }
      if (!script.data || !post.data || !brand.data) return null;

      let personName: string | null = null;
      if (video.avatar_id) {
        const { data: avatar, error: avatarError } = await db.from("avatars").select("consent_id").eq("id", video.avatar_id).maybeSingle();
        if (avatarError) fail("load twin", avatarError);
        if (avatar?.consent_id) {
          const { data: consent, error: consentError } = await db
            .from("consents")
            .select("person_legal_name")
            .eq("id", avatar.consent_id)
            .maybeSingle();
          if (consentError) fail("load consent", consentError);
          personName = (consent?.person_legal_name as string | undefined) ?? null;
        }
      }
      const { data: words, error: wordsError } = await db
        .from("pronunciations")
        .select("written, say_as, status")
        .eq("brand_id", video.brand_id)
        .limit(1000);
      if (wordsError) fail("load pronunciations", wordsError);
      const { data: owner, error: ownerError } = await db.from("profiles").select("plan").eq("id", brand.data.owner_id).maybeSingle();
      if (ownerError) fail("load the owner's plan", ownerError);

      const { owner_id: _owner, ...brandRow } = brand.data;
      void _owner;
      const { avatar_id: _avatar, ...videoRow } = video;
      void _avatar;
      return {
        video: { ...videoRow, duration_s: video.duration_s === null ? null : Number(video.duration_s) },
        script: {
          ...script.data,
          display_text: script.data.display_text ?? "",
          spoken_text: script.data.spoken_text ?? "",
          hook: script.data.hook ?? "",
          cta: script.data.cta ?? "",
          est_seconds: Number(script.data.est_seconds ?? 0),
        },
        post: post.data,
        brand: { ...brandRow, words_per_second: Number(brandRow.words_per_second) },
        personName,
        dictionary: (words ?? []) as PronunciationEntry[],
        maxSeconds: maxSecondsFor((owner?.plan as string | null | undefined) ?? null),
      } as GateContext;
    },
    async moveVideo(videoId, to, from, error) {
      const patch = error === undefined ? { status: to } : { status: to, error };
      const { data, error: dbError } = await db.from("videos").update(patch).eq("id", videoId).in("status", from).select("id").maybeSingle();
      if (dbError) fail("move video", dbError);
      return data !== null;
    },
    async setPostStatus(postId, status, reason) {
      const { error } = await db.from("posts").update({ status, status_reason: reason }).eq("id", postId);
      if (error) fail("update post status", error);
    },
    async saveTranscript(videoId, transcript) {
      const { error } = await db.from("videos").update({ transcript }).eq("id", videoId);
      if (error) fail("save transcript", error);
    },
    async insertQaReport(row) {
      const { error } = await db.from("qa_reports").insert(row);
      if (error) fail("save QA report", error);
    },
    async countFailedReports(videoId, gate) {
      const { count, error } = await db
        .from("qa_reports")
        .select("id", { count: "exact", head: true })
        .eq("video_id", videoId)
        .eq("gate", gate)
        .eq("passed", false);
      if (error) fail("count QA reports", error);
      return count ?? 0;
    },
    async saveQaRespelling(brandId, written, sayAs) {
      // An automatic Gate 3 fix: APPROVED (only approved rows are applied, lib/pronunciation/dictionary.ts),
      // source 'qa' so the operator sees where it came from in How to say names.
      const update = () =>
        db
          .from("pronunciations")
          .update({ say_as: sayAs, status: "approved", source: "qa" })
          .eq("brand_id", brandId)
          .ilike("written", likeExact(written))
          .select("id");
      const { data, error } = await update();
      if (error) fail("save respelling", error);
      if ((data ?? []).length > 0) return;
      const { error: insertError } = await db
        .from("pronunciations")
        .insert({ brand_id: brandId, written, say_as: sayAs, status: "approved", source: "qa" });
      if (!insertError) return;
      if (insertError.code !== UNIQUE_VIOLATION) fail("save respelling", insertError);
      const { error: retryError } = await update(); // added meanwhile: update it instead
      if (retryError) fail("save respelling", retryError);
    },
    async updateSpokenText(scriptId, spokenText) {
      const { error } = await db.from("scripts").update({ spoken_text: spokenText }).eq("id", scriptId);
      if (error) fail("update spoken text", error);
    },
    async createQaRerender(videoId, spokenWords, fixNote) {
      const { data, error } = await db.rpc("create_qa_rerender", { p_video_id: videoId, p_spoken_words: spokenWords, p_fix_note: fixNote });
      if (error) fail("make the QA re-render", error);
      return rerenderResult(data);
    },
    async countFailedScriptReports(scriptId, gate) {
      const { count, error } = await db
        .from("qa_reports")
        .select("id", { count: "exact", head: true })
        .eq("script_id", scriptId)
        .eq("gate", gate)
        .eq("passed", false);
      if (error) fail("count QA reports", error);
      return count ?? 0;
    },
    async countBrandPostsPassed(brandId, gate, excludePostId) {
      // Only the first few matter (HUMAN_REVIEW.first_videos_per_brand); 1000 rows is far more than enough.
      const { data, error } = await db
        .from("qa_reports")
        .select("videos!inner(post_id, brand_id)")
        .eq("gate", gate)
        .eq("passed", true)
        .eq("videos.brand_id", brandId)
        .limit(1000);
      if (error) fail("count passed videos", error);
      return distinctPosts((data ?? []) as unknown as { videos: { post_id: string | null } | null }[], excludePostId);
    },
    async teamReviewsEveryVideo(brandId) {
      const { data, error } = await db.from("brand_qa_settings").select("team_reviews_every_video").eq("brand_id", brandId).maybeSingle();
      if (error) fail("load brand QA settings", error);
      return data?.team_reviews_every_video ?? true; // no row = on (QA-SPEC: until the operator turns it off)
    },
    async prepareReedit(videoId, fixNote, reason) {
      const { data, error } = await db
        .from("videos")
        .update({ status: "audio_qa", qa_fix_note: fixNote.slice(0, 1000), error: reason })
        .eq("id", videoId)
        .eq("status", "final_qa")
        .select("id")
        .maybeSingle();
      if (error) fail("prepare the re-edit", error);
      return data !== null;
    },
    async createVisualRerender(videoId, fixNote) {
      const { data, error } = await db.rpc("create_visual_rerender", { p_video_id: videoId, p_fix_note: fixNote });
      if (error) fail("make the visual re-render", error);
      return rerenderResult(data);
    },
    async deliverVideo(videoId) {
      const { data, error } = await db.rpc("deliver_post_video", { p_video_id: videoId });
      if (error) fail("deliver the video", error);
      return deliverResult(data);
    },
  };
}
