import "server-only";
import type { AvatarRow } from "@/lib/consent-store-types";
import { createAdminClient } from "@/lib/supabase/admin";
import { z } from "zod";
import type { ClaimResult, LateRender, PostRenderOutcome, VideoFiles, VideoRow, VideoStore } from "@/lib/video-store-types";

export type { PostRenderOutcome };

// Supabase versions of VideoStore and VideoFiles. They use the SECRET key,
// so call them only after requireAdmin(), after a verified webhook signature,
// or inside a background task. Tests use tests/helpers/video-memory.ts.

/** The existing PRIVATE bucket (Phase 1 migration). Raw HeyGen MP4s go under raw/. */
export const VIDEO_BUCKET = "videos";

function fail(what: string, error: { message: string } | null): never {
  throw new Error(`[videos] ${what}: ${error?.message ?? "no data"}`);
}

/** numeric columns come back as strings from PostgREST. */
function toVideo(row: Record<string, unknown> | null): VideoRow | null {
  if (!row) return null;
  return { ...(row as VideoRow), duration_s: row.duration_s === null ? null : Number(row.duration_s) };
}

const postRenderAnswer = z.object({
  outcome: z.enum(["created", "existing", "not_approved"]),
  video_id: z.string().nullable(),
});

/**
 * The create_post_render rpc answer (p4-b1). A unique violation (23505) means
 * a second active video for the script was refused by the index
 * videos_one_active_post_video: the same plain refusal as 'not_approved'.
 */
export function postRenderResult(data: unknown, error: { code?: string; message: string } | null): PostRenderOutcome {
  if (error?.code === "23505") return { outcome: "not_approved", videoId: null };
  if (error) fail("create post render", error);
  const parsed = postRenderAnswer.safeParse(data);
  if (!parsed.success) fail("create post render", { message: "unexpected answer" });
  return { outcome: parsed.data.outcome, videoId: parsed.data.video_id };
}

export function createVideoStore(): VideoStore {
  const db = createAdminClient();
  return {
    async getVideo(id) {
      const { data, error } = await db.from("videos").select().eq("id", id).maybeSingle();
      if (error) fail("load video", error);
      return toVideo(data);
    },
    async getVideoByHeygenId(heygenVideoId) {
      const { data, error } = await db.from("videos").select().eq("heygen_video_id", heygenVideoId).maybeSingle();
      if (error) fail("load video by HeyGen id", error);
      return toVideo(data);
    },
    async insertVideo(row) {
      const { data, error } = await db.from("videos").insert(row).select().single();
      if (error || !data) fail("insert video", error);
      return toVideo(data)!;
    },
    async updateVideo(id, patch) {
      const { data, error } = await db.from("videos").update(patch).eq("id", id).select().maybeSingle();
      if (error) fail("update video", error);
      return toVideo(data);
    },
    async claimRenderSlot(id, max) {
      const { data, error } = await db.rpc("claim_render_slot", { p_video_id: id, p_max: max });
      if (error) fail("claim render slot", error);
      return data as ClaimResult;
    },
    async createPostVideo(input) {
      const { data, error } = await db.rpc("create_post_render", {
        p_post_id: input.postId,
        p_script_id: input.scriptId,
        p_brand_id: input.brandId,
        p_avatar_id: input.avatarId,
        p_engine: input.engine,
        p_spoken_words: input.spokenWords,
      });
      return postRenderResult(data, error);
    },
    async adoptLateRender(id, heygenVideoId) {
      const { data, error } = await db.rpc("adopt_late_render", { p_video_id: id, p_heygen_video_id: heygenVideoId });
      if (error) fail("adopt late render", error);
      return data as LateRender;
    },
    async finishRender(id, patch) {
      const { data, error } = await db.from("videos").update(patch).eq("id", id).eq("status", "rendering").select().maybeSingle();
      if (error) fail("finish render", error);
      return toVideo(data);
    },
    async findActiveVideoForScript(scriptId) {
      const { data, error } = await db
        .from("videos")
        .select()
        .eq("script_id", scriptId)
        .not("status", "in", "(failed,skipped)")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) fail("find video for script", error);
      return toVideo(data);
    },
    async listLikenessVideos(avatarId) {
      const { data, error } = await db
        .from("videos")
        .select()
        .eq("avatar_id", avatarId)
        .eq("kind", "likeness_test")
        .order("created_at", { ascending: true });
      if (error) fail("list likeness videos", error);
      return (data ?? []).map((row) => toVideo(row)!);
    },
    async getRenderablePost(postId) {
      const { data: post, error } = await db.from("posts").select("id, brand_id, status, title").eq("id", postId).maybeSingle();
      if (error) fail("load post", error);
      if (!post) return null;
      const { data: script, error: scriptError } = await db
        .from("scripts")
        .select("id, spoken_text, qa_status")
        .eq("post_id", postId)
        .order("version", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (scriptError) fail("load script", scriptError);
      return { post, script: script ?? null };
    },
    async getScriptText(scriptId) {
      const { data, error } = await db.from("scripts").select("spoken_text, post_id").eq("id", scriptId).maybeSingle();
      if (error) fail("load script text", error);
      return data ? { spokenText: data.spoken_text, postId: data.post_id } : null;
    },
    async setPostStatus(postId, status, reason) {
      const { error } = await db.from("posts").update({ status, status_reason: reason }).eq("id", postId);
      if (error) fail("update post status", error);
    },
    async getBrand(brandId) {
      const { data, error } = await db.from("brands").select("id, name, engine, paused").eq("id", brandId).maybeSingle();
      if (error) fail("load brand", error);
      return data ?? null;
    },
    async setBrandEngine(brandId, engine) {
      const { error } = await db.from("brands").update({ engine }).eq("id", brandId);
      if (error) fail("save engine", error);
    },
    async recentRenderSamples(brandId, limit) {
      const { data, error } = await db
        .from("videos")
        .select("spoken_words, duration_s")
        .eq("brand_id", brandId)
        .eq("kind", "post")
        .not("rendered_at", "is", null)
        .not("spoken_words", "is", null)
        .not("duration_s", "is", null)
        .order("rendered_at", { ascending: false })
        .limit(limit);
      if (error) fail("load render samples", error);
      return (data ?? []).map((row) => ({ words: Number(row.spoken_words), durationS: Number(row.duration_s) }));
    },
    async setWordsPerSecond(brandId, wordsPerSecond) {
      const { error } = await db.from("brands").update({ words_per_second: wordsPerSecond }).eq("id", brandId);
      if (error) fail("save words per second", error);
    },
    async getAvatar(id) {
      const { data, error } = await db.from("avatars").select().eq("id", id).maybeSingle();
      if (error) fail("load avatar", error);
      return (data as AvatarRow | null) ?? null;
    },
    async getReadyAvatar(brandId) {
      const { data, error } = await db
        .from("avatars")
        .select()
        .eq("brand_id", brandId)
        .eq("status", "ready")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) fail("load ready avatar", error);
      return (data as AvatarRow | null) ?? null;
    },
    async getHeygenConsentStatus(consentId) {
      const { data, error } = await db.from("consents").select("heygen_consent_status").eq("id", consentId).maybeSingle();
      if (error) fail("load HeyGen consent", error);
      return data?.heygen_consent_status ?? null;
    },
    async saveWebhookEvent(eventKey, payload) {
      // Unique event_key: a repeat inserts nothing (ignoreDuplicates = on conflict do nothing).
      const { data, error } = await db
        .from("webhook_events")
        .upsert({ source: "heygen", event_key: eventKey, payload }, { onConflict: "event_key", ignoreDuplicates: true })
        .select("id");
      if (error) fail("save webhook event", error);
      if (data && data.length > 0) return "new";
      const { data: existing, error: readError } = await db
        .from("webhook_events")
        .select("processed_at")
        .eq("event_key", eventKey)
        .maybeSingle();
      if (readError) fail("load webhook event", readError);
      return existing?.processed_at ? "processed" : "unprocessed";
    },
    async markWebhookProcessed(eventKey) {
      const { error } = await db.from("webhook_events").update({ processed_at: new Date().toISOString() }).eq("event_key", eventKey);
      if (error) fail("mark webhook processed", error);
    },
  };
}

/** The PRIVATE videos bucket. Browsers only ever get signed, short-lived URLs. */
export function createVideoFiles(): VideoFiles {
  const bucket = createAdminClient().storage.from(VIDEO_BUCKET);
  return {
    async upload(path, bytes, contentType) {
      const { error } = await bucket.upload(path, bytes, { contentType, upsert: true });
      if (error) fail("upload video", error);
    },
    async signedUrl(path, seconds) {
      const { data, error } = await bucket.createSignedUrl(path, seconds);
      if (error || !data) fail("create playback URL", error);
      return data.signedUrl;
    },
  };
}
