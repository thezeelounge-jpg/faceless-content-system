import type { AvatarRow } from "@/lib/consent-store-types";

// Rows and storage used by renders, likeness tests and HeyGen webhooks. The
// real versions use Supabase (lib/video-store.ts, secret key, server only);
// tests use tests/helpers/video-memory.ts.

export type VideoKind = "post" | "likeness_test";
export type VideoRowStatus =
  | "queued"
  | "rendering"
  | "rendered"
  | "audio_qa"
  | "editing"
  | "final_qa"
  | "team_review"
  | "needs_you"
  | "ready"
  | "failed"
  | "skipped";

export type VideoRow = {
  id: string;
  brand_id: string;
  script_id: string | null;
  avatar_id: string | null;
  kind: VideoKind;
  engine: string | null;
  attempt: number;
  heygen_video_id: string | null;
  status: VideoRowStatus;
  /** Path in the PRIVATE videos bucket (raw/<brand>/<video>.mp4). */
  raw_path: string | null;
  duration_s: number | null;
  /** Words in the text sent to HeyGen (for words_per_second). */
  spoken_words: number | null;
  /** Our claim, set atomically right before the paid POST /v3/videos. */
  render_started_at: string | null;
  rendered_at: string | null;
  counts_toward_plan: boolean;
  error: string | null;
  created_at: string;
};

export type NewVideoRow = Pick<VideoRow, "brand_id" | "script_id" | "avatar_id" | "kind" | "engine" | "spoken_words">;

export type VideoPatch = Partial<
  Pick<VideoRow, "heygen_video_id" | "status" | "raw_path" | "duration_s" | "render_started_at" | "rendered_at" | "error">
>;

export type RenderBrand = { id: string; name: string; engine: string | null; paused: boolean };

export type RenderablePost = {
  post: { id: string; brand_id: string; status: string; title: string };
  /** The newest script version, or null. */
  script: { id: string; spoken_text: string | null; qa_status: string } | null;
};

/** One finished post render, for brands.words_per_second. */
export type RenderSample = { words: number; durationS: number };

export type NewPostVideo = {
  postId: string;
  scriptId: string;
  brandId: string;
  avatarId: string;
  engine: string;
  spokenWords: number;
};
/** other_script (p4-b3, Q8): the post already has an active video for an older script version. */
export type PostRenderOutcome = { outcome: "created" | "existing" | "other_script" | "not_approved"; videoId: string | null };

export type ClaimResult ="claimed" | "taken" | "busy" | "missing";
/** adopt_late_render (p4-fix c2): what happened to a HeyGen success that arrived after the claim was cleared. */
export type LateRender = "adopted" | "moved_on" | "not_late";
export type WebhookSave = "new" | "unprocessed" | "processed";

export interface VideoStore {
  getVideo(id: string): Promise<VideoRow | null>;
  getVideoByHeygenId(heygenVideoId: string): Promise<VideoRow | null>;
  insertVideo(row: NewVideoRow): Promise<VideoRow>;
  updateVideo(id: string, patch: VideoPatch): Promise<VideoRow | null>;
  /** claim_render_slot: atomic claim + the "at most `max` rendering" cap. */
  claimRenderSlot(id: string, max: number): Promise<ClaimResult>;
  /** Saves the result only while the video is still 'rendering'. Null when someone else already finished it. */
  finishRender(id: string, patch: VideoPatch): Promise<VideoRow | null>;
  /**
   * adopt_late_render: a failed row that reached HeyGen with no id (claim cleared, or the wait ran
   * out) gets HeyGen's late success. 'adopted' = id saved, back to 'rendering' (download next);
   * 'moved_on' = a newer render exists, only the late id is recorded; 'not_late' = nothing done.
   * Never writes provider_usage.
   */
  adoptLateRender(id: string, heygenVideoId: string): Promise<LateRender>;
  /** A video for this script that is not failed or skipped (newest), or null. */
  findActiveVideoForScript(scriptId: string): Promise<VideoRow | null>;
  /**
   * create_post_render (p4-b1): the ONLY "Make video" insert path. Under the per-post lock
   * (shared with adopt_late_render): post still approved and this its newest script, else
   * 'not_approved'; an active video for the script → 'existing'; otherwise a new queued row.
   */
  createPostVideo(input: NewPostVideo): Promise<PostRenderOutcome>;
  listLikenessVideos(avatarId: string): Promise<VideoRow[]>;

  getRenderablePost(postId: string): Promise<RenderablePost | null>;
  /** The script's text to speak and its post. */
  getScriptText(scriptId: string): Promise<{ spokenText: string | null; postId: string } | null>;
  setPostStatus(postId: string, status: string, reason: string | null): Promise<void>;

  getBrand(brandId: string): Promise<RenderBrand | null>;
  setBrandEngine(brandId: string, engine: string): Promise<void>;
  /** Newest first: finished POST renders (likeness tests excluded) with words and a duration. */
  recentRenderSamples(brandId: string, limit: number): Promise<RenderSample[]>;
  setWordsPerSecond(brandId: string, wordsPerSecond: number): Promise<void>;

  getAvatar(id: string): Promise<AvatarRow | null>;
  /** The brand's newest twin with status 'ready', or null. */
  getReadyAvatar(brandId: string): Promise<AvatarRow | null>;
  /** consents.heygen_consent_status (HeyGen's own consent: must be 'accepted' before any render). */
  getHeygenConsentStatus(consentId: string): Promise<string | null>;

  /** Stores a webhook event once per key. 'new' = first time; otherwise whether it was already processed. */
  saveWebhookEvent(eventKey: string, payload: unknown): Promise<WebhookSave>;
  markWebhookProcessed(eventKey: string): Promise<void>;
}

/** The PRIVATE videos bucket. Browsers only get short-lived signed URLs. */
export interface VideoFiles {
  /** Overwrites (upsert): the same video always lands on the same path. */
  upload(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  signedUrl(path: string, seconds: number): Promise<string>;
}
