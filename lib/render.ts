import "server-only";
import { redact } from "@/lib/admin-errors";
import { HeygenError, type HeygenClient, type HeygenErrorCode } from "@/lib/heygen";
import { SpendGuardError, withHeygenSpend, type SpendStore } from "@/lib/heygen-spend";
import { releasePlanSlot, reservePlanSlot } from "@/lib/plan-slots";
import { PlainError } from "@/lib/plain-error";
import { RENDER, WORDS_PER_SECOND } from "@/lib/qa/config";
import { countWords } from "@/lib/scripts";
import type { RenderSample, VideoFiles, VideoRow, VideoStore } from "@/lib/video-store-types";

// Making a video on HeyGen (Phase 3 item 7), and finishing it (item 8).
// Plain functions, tested with mock/fake HeyGen and in-memory stores;
// trigger/render-video.ts and trigger/poll-render.ts only call these.
//
// Money rules (CLAUDE.md, hard):
// - Mock mode (MOCK_HEYGEN not exactly "false"): the mock client never fetches.
// - Real mode: renderVideo refuses unless the admin confirmed the spend
//   (confirmSpend === true, from a zod-checked Server Action), before ANY call.
// - Every render goes through withHeygenSpend (kind "render"): renders_paused,
//   brands.paused and the daily cap apply, and a provider_usage row is written.
// - Never twice: videos.render_started_at is claimed atomically (with the
//   10-at-once cap) right before the POST; heygen_video_id saved → never POST again.
// - Never a different engine than the one chosen (no silent fallback).
//
// videos.status: queued → rendering (claimed, POST sent) → rendered (raw MP4
// in the private bucket) | failed (plain reason in videos.error).
// The "unknown" state (SF3) is NOT a new status: 'rendering' + render_started_at
// set + heygen_video_id null (+ RENDER_UNKNOWN in error). Keeping 'rendering'
// means it still counts toward the 10-at-once cap (HeyGen may be rendering it),
// claim_render_slot refuses it, and the webhook backfill already matches it.

export type RenderDeps = {
  videos: VideoStore;
  heygen: HeygenClient;
  spend: SpendStore;
  /** The admin ticked "I agree to spend". Required when HeyGen is NOT mocked. */
  confirmSpend?: boolean;
  /** heygenCallbackUrl(): only with a public https site. */
  callbackUrl?: string | null;
};

export type RenderStart =
  | { status: "started"; heygenVideoId: string }
  | { status: "already_started"; heygenVideoId: string }
  /** All render slots are busy: try again later (the video stays queued). */
  | { status: "waiting" }
  /**
   * SF3: the POST may have reached HeyGen (timeout, 5xx, crash) but we have
   * no HeyGen id. The video stays 'rendering' with its claim (never POSTed
   * again); the webhook (callback_id) or the poll finishes it.
   */
  | { status: "unknown" };

export type RenderOutcome =
  | { ok: true; videoUrl: string | null; durationS: number | null }
  | { ok: false; reason: string | null };

export type CompleteDeps = {
  videos: VideoStore;
  heygen: HeygenClient;
  files: VideoFiles;
  /** Injectable downloader (tests: a fake returning fixture bytes). Defaults to heygen.downloadVideo. */
  download?: (url: string | null) => Promise<Uint8Array>;
  /** The clock (tests pass a fixed time). Defaults to now. */
  now?: () => Date;
};

/** The fixed line every likeness-test render says (about 15 seconds at 2.4 words a second). */
export const LIKENESS_LINE =
  "Hi, I'm testing my digital twin today. I want to see how natural my face, my voice and my hands look when I talk. " +
  "If this feels like a real video of me, we can start making my posts.";

/** Make video refused: the post is not approved (or moved on, e.g. a late render was adopted). */
export const NOT_APPROVED_FOR_VIDEO = "Only an approved script can be made into a video.";

/** p4-b3 (Q8): an active video exists for an OLDER script of the same post (admin wording). */
export const OTHER_SCRIPT_VIDEO = "This post already has a video for an earlier version of its script. Clear that one first.";

export const NEEDS_SPEND_CONFIRM =
  "A real HeyGen render costs money. Tick “I agree to spend” first. Nothing was sent to HeyGen.";

/** SF2 for renders: shown when a render may exist on HeyGen but its id was never saved. */
export const LOST_RENDER =
  "This video may already be rendering on HeyGen, but we did not save its id. Check the HeyGen dashboard before rendering again.";

/** SF3: saved on a video whose POST answer was lost (timeout, 5xx, crash). Admin wording. */
export const RENDER_UNKNOWN = `HeyGen did not answer clearly, so this video may be rendering. It will not be sent again; we wait up to ${
  RENDER.poll_max_s / 60
} minutes for HeyGen's update.`;

/** SF5: the unknown wait ran out with no word from HeyGen. Admin wording; the post goes to the team queue. */
export const UNKNOWN_TIMEOUT = `HeyGen never confirmed this video within ${
  RENDER.poll_max_s / 60
} minutes. Check the HeyGen dashboard before rendering again.`;

/** HeyGen answers that prove nothing was rendered (see lib/twin.ts for the same idea). */
const HEYGEN_DID_NOT_RENDER: HeygenErrorCode[] = ["not_set_up", "unauthorized", "not_found", "bad_request", "busy"];

/** Our own plain words only (redacted); never raw bodies. */
function plain(error: unknown): string {
  return error instanceof PlainError ? redact(error.message).slice(0, 300) : "Something went wrong talking to HeyGen. See server logs.";
}

/** The webhook address for callback_url, only when the site has a public https URL. */
export function heygenCallbackUrl(env: Record<string, string | undefined> = process.env): string | null {
  const raw = env.NEXT_PUBLIC_SITE_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}/api/webhooks/heygen`;
  } catch {
    return null;
  }
}

function engineProblem(engine: string | null, supported: string[]): string | null {
  if (!engine) return "No engine chosen for this client. Run the likeness test first.";
  if (!supported.includes(engine)) return `The twin does not support the chosen engine (${engine}). Run the likeness test again.`;
  return null;
}

/**
 * Makes (or returns) the queued video for a post's approved script. Checks:
 * post approved, newest script passed QA with spoken text, a ready twin, and
 * the brand's chosen engine is one the twin supports.
 */
export async function createPostRender(postId: string, deps: { videos: VideoStore }): Promise<VideoRow> {
  const found = await deps.videos.getRenderablePost(postId);
  if (!found) throw new PlainError("Post not found.");
  const { post, script } = found;
  if (post.status !== "approved") throw new PlainError(NOT_APPROVED_FOR_VIDEO);
  if (!script || script.qa_status !== "passed") throw new PlainError("The script has not passed its checks.");
  if (!script.spoken_text?.trim()) throw new PlainError("The script has no spoken text.");

  const existing = await deps.videos.findActiveVideoForScript(script.id);
  if (existing) return existing;

  const avatar = await deps.videos.getReadyAvatar(post.brand_id);
  if (!avatar) throw new PlainError("This client has no ready twin yet. Finish the likeness test first.");
  const brand = await deps.videos.getBrand(post.brand_id);
  if (!brand) throw new PlainError("Client not found.");
  const problem = engineProblem(brand.engine, avatar.supported_engines);
  if (problem) throw new PlainError(problem);

  // p4-b1 (QA SF1): the checks above are only for plain messages. The database re-checks
  // "approved + no active video" and inserts under the same per-post lock as
  // adopt_late_render, so a late webhook in between can never lead to a second render.
  const made = await deps.videos.createPostVideo({
    postId: post.id,
    scriptId: script.id,
    brandId: post.brand_id,
    avatarId: avatar.id,
    engine: brand.engine!,
    spokenWords: countWords(script.spoken_text),
  });
  // p4-b3 (Q8): never hand back a video that says an older script's words.
  if (made.outcome === "other_script") throw new PlainError(OTHER_SCRIPT_VIDEO);
  if (made.outcome === "not_approved" || !made.videoId) throw new PlainError(NOT_APPROVED_FOR_VIDEO);
  const video = await deps.videos.getVideo(made.videoId);
  if (!video) throw new PlainError("Video not found.");
  return video;
}

/** The text HeyGen should say, and the post it belongs to (null for likeness tests). */
async function textFor(video: VideoRow, store: VideoStore): Promise<{ text: string; postId: string | null }> {
  if (video.kind === "likeness_test") return { text: LIKENESS_LINE, postId: null };
  const script = video.script_id ? await store.getScriptText(video.script_id) : null;
  if (!script?.spokenText?.trim()) throw new PlainError("The script has no spoken text.");
  return { text: script.spokenText, postId: script.postId };
}

/**
 * Sends one queued video to HeyGen (POST /v3/videos). Safe to run again:
 * a saved HeyGen id → "already_started"; a claim without an id → refuses.
 * All 10 slots busy → "waiting" (the video stays queued; the task waits).
 */
export async function renderVideo(videoId: string, deps: RenderDeps): Promise<RenderStart> {
  const video = await deps.videos.getVideo(videoId);
  if (!video) throw new PlainError("Video not found.");
  if (video.heygen_video_id) return { status: "already_started", heygenVideoId: video.heygen_video_id };
  if (video.render_started_at) {
    // SF3: claimed, no id, still 'rendering' → the unknown state: never POST again; webhook/poll finish it.
    if (video.status === "rendering") return { status: "unknown" };
    await deps.videos.updateVideo(video.id, { error: LOST_RENDER });
    throw new PlainError(LOST_RENDER);
  }
  // Money rule: a real render needs the admin's explicit OK. Checked before anything else.
  if (!deps.heygen.mock && deps.confirmSpend !== true) throw new PlainError(NEEDS_SPEND_CONFIRM);

  const { text, postId } = await textFor(video, deps.videos);
  const avatar = video.avatar_id ? await deps.videos.getAvatar(video.avatar_id) : null;
  if (!avatar?.heygen_look_id || !avatar.voice_id) throw new PlainError("The twin has no look or no voice yet. Check the twin first.");
  const problem = engineProblem(video.engine, avatar.supported_engines);
  if (problem) throw new PlainError(problem);
  // CLAUDE.md: no render with a customer's twin before HeyGen consent is accepted.
  const consent = avatar.consent_id ? await deps.videos.getHeygenConsentStatus(avatar.consent_id) : null;
  if (consent !== "accepted") {
    throw new PlainError("HeyGen's own consent for this twin is not accepted yet. Nothing was sent to HeyGen.");
  }

  const claim = await deps.videos.claimRenderSlot(video.id, RENDER.max_concurrent);
  if (claim === "busy") return { status: "waiting" };
  if (claim === "missing") throw new PlainError("Video not found.");
  if (claim === "taken") {
    const now = await deps.videos.getVideo(video.id);
    if (now?.heygen_video_id) return { status: "already_started", heygenVideoId: now.heygen_video_id };
    if (now?.status === "rendering" && now.render_started_at) return { status: "unknown" };
    throw new PlainError(LOST_RENDER);
  }

  // p5-a2: our own QA re-render (attempt 2+, create_qa_rerender) reserves no plan slot: the
  // customer's one slot was reserved by the first render (QA-SPEC "our failures are free").
  const counts = video.kind === "post" && video.attempt === 1;
  if (counts) await reservePlanSlot(video);
  let heygenVideoId: string;
  try {
    ({ videoId: heygenVideoId } = await withHeygenSpend(
      { kind: "render", brandId: video.brand_id, avatarId: avatar.id, videoId: video.id, mock: deps.heygen.mock, store: deps.spend },
      () =>
        deps.heygen.createVideo({
          lookId: avatar.heygen_look_id!,
          spokenText: text,
          voiceId: avatar.voice_id!,
          engine: video.engine!,
          callbackId: video.id,
          callbackUrl: deps.callbackUrl ?? null,
          title: video.kind === "likeness_test" ? `Likeness test ${video.engine}` : `Post video ${video.id}`,
        }),
    ));
  } catch (error) {
    const guarded = error instanceof SpendGuardError;
    const refused = error instanceof HeygenError && HEYGEN_DID_NOT_RENDER.includes(error.code);
    if (guarded || refused) {
      // Nothing was rendered: free the claim and the plan slot. Pauses, caps and "busy" wait in the queue; a real refusal fails.
      if (counts) await releasePlanSlot(video).catch(() => null);
      const waitable = guarded || (error instanceof HeygenError && error.code === "busy");
      await deps.videos.updateVideo(video.id, { status: waitable ? "queued" : "failed", render_started_at: null, error: plain(error) });
      throw error;
    }
    // SF3: a timeout, a 5xx or anything else after the POST left: HeyGen may be rendering (and charging).
    // NOT failed: stay 'rendering' with the claim (never POST again) and no id, the "unknown" state.
    // The webhook (callback_id = our id) or the poll finishes it; after RENDER.poll_max_s the poll
    // fails it to the team queue (SF5). The plan slot stays reserved until then.
    await deps.videos.updateVideo(video.id, { error: RENDER_UNKNOWN }).catch(() => null);
    if (postId) await deps.videos.setPostStatus(postId, "rendering", null).catch(() => null);
    return { status: "unknown" };
  }
  await deps.videos.updateVideo(video.id, { heygen_video_id: heygenVideoId, error: null });
  if (postId) await deps.videos.setPostStatus(postId, "rendering", null);
  return { status: "started", heygenVideoId };
}

// ---------------------------------------------------------------------------
// Finishing a render (webhook or polling)
// ---------------------------------------------------------------------------

const SAVE_FAILED = "Could not save the finished video. It will be tried again.";
const POLL_TIMEOUT = "HeyGen did not finish within 30 minutes. Check the HeyGen dashboard before rendering again.";
const TEAM_REASON = "The video could not be made. The team will look at it.";

/** Where the raw MP4 lives in the PRIVATE videos bucket. */
export function rawVideoPath(video: Pick<VideoRow, "brand_id" | "id">): string {
  return `raw/${video.brand_id}/${video.id}.mp4`;
}

/**
 * brands.words_per_second: the average of words/duration over the newest
 * WORDS_PER_SECOND.window usable samples (newest first in). Zero, tiny, huge
 * or non-numeric durations and absurd speeds are skipped and do not use up
 * the window. Rounded to 2 decimals (the column is numeric(4,2)). Null when
 * no sample is usable.
 */
export function rollingWordsPerSecond(samples: RenderSample[]): number | null {
  const rates: number[] = [];
  for (const { words, durationS } of samples) {
    if (!Number.isFinite(durationS) || !Number.isFinite(words) || words <= 0) continue;
    if (durationS < WORDS_PER_SECOND.min_duration_s || durationS > WORDS_PER_SECOND.max_duration_s) continue;
    const rate = words / durationS;
    if (rate < WORDS_PER_SECOND.min_wps || rate > WORDS_PER_SECOND.max_wps) continue;
    rates.push(rate);
    if (rates.length === WORDS_PER_SECOND.window) break;
  }
  if (rates.length === 0) return null;
  return Math.round((rates.reduce((a, b) => a + b, 0) / rates.length) * 100) / 100;
}

/** Recomputes brands.words_per_second from the brand's newest finished post renders. */
async function updateWordsPerSecond(brandId: string, store: VideoStore): Promise<void> {
  // Ask for more than the window, so skipped samples don't shrink it.
  const wps = rollingWordsPerSecond(await store.recentRenderSamples(brandId, WORDS_PER_SECOND.window * 5));
  if (wps !== null) await store.setWordsPerSecond(brandId, wps);
}

async function failRender(video: VideoRow, error: string, store: VideoStore): Promise<boolean> {
  const saved = await store.finishRender(video.id, { status: "failed", error });
  if (!saved) return false;
  if (video.kind === "post") {
    await releasePlanSlot(video).catch(() => null);
    const script = video.script_id ? await store.getScriptText(video.script_id) : null;
    if (script) await store.setPostStatus(script.postId, "team_review", TEAM_REASON);
  }
  return true;
}

/**
 * Finishes a render once, from the webhook or the poll. Only a video still
 * 'rendering' is touched, so a repeat (webhook twice, webhook + poll) does
 * nothing. Success: download at once (the URL expires) into the private
 * bucket, save path, duration, status 'rendered', then words_per_second.
 */
export async function completeRender(
  videoId: string,
  outcome: RenderOutcome,
  deps: CompleteDeps,
): Promise<{ status: "rendered" | "failed" | "already_done" }> {
  const video = await deps.videos.getVideo(videoId);
  if (!video) throw new PlainError("Video not found.");
  if (video.status !== "rendering") return { status: "already_done" };

  if (!outcome.ok) {
    const reason = outcome.reason?.trim();
    const error = reason
      ? `HeyGen could not make the video: ${redact(reason).slice(0, 200)}`
      : "HeyGen could not make the video (no reason given).";
    return { status: (await failRender(video, error, deps.videos)) ? "failed" : "already_done" };
  }

  const path = rawVideoPath(video);
  try {
    const download = deps.download ?? ((url: string | null) => deps.heygen.downloadVideo(url ?? ""));
    const bytes = await download(outcome.videoUrl);
    await deps.files.upload(path, bytes, "video/mp4");
  } catch (error) {
    // A refused link (lib/safe-download.ts) gets its own plain reason; never the URL.
    const refused = error instanceof HeygenError && error.code === "bad_output";
    await deps.videos.updateVideo(video.id, { error: refused ? plain(error) : SAVE_FAILED }).catch(() => null);
    throw error;
  }
  const duration = outcome.durationS !== null && Number.isFinite(outcome.durationS) && outcome.durationS > 0 ? outcome.durationS : null;
  const saved = await deps.videos.finishRender(video.id, {
    status: "rendered",
    raw_path: path,
    duration_s: duration,
    rendered_at: new Date().toISOString(),
    error: null,
  });
  if (!saved) return { status: "already_done" };
  if (video.kind === "post") await updateWordsPerSecond(video.brand_id, deps.videos);
  return { status: "rendered" };
}

/** One check on HeyGen (GET /v3/videos/{id}, free). Skips videos the webhook already finished. */
export async function pollRenderOnce(videoId: string, deps: CompleteDeps): Promise<{ done: boolean; status: string }> {
  const video = await deps.videos.getVideo(videoId);
  if (!video) throw new PlainError("Video not found.");
  if (video.status !== "rendering") return { done: true, status: video.status };
  if (!video.heygen_video_id) {
    // SF3/SF5: the unknown state (claimed, POST answer lost). Only the webhook can tell us HeyGen's id
    // (callback_id). Wait until RENDER.poll_max_s after the claim, then hand it to the team.
    const started = video.render_started_at ? Date.parse(video.render_started_at) : NaN;
    const now = (deps.now ?? (() => new Date()))().getTime();
    if (Number.isFinite(started) && now - started < RENDER.poll_max_s * 1000) return { done: false, status: "unknown" };
    if (await failRender(video, UNKNOWN_TIMEOUT, deps.videos)) return { done: true, status: "failed" };
    return { done: true, status: (await deps.videos.getVideo(video.id))?.status ?? "unknown" };
  }

  const state = await deps.heygen.getVideo(video.heygen_video_id);
  // Docs list only "completed" and "failed"; anything else means still working.
  if (state.status !== "completed" && state.status !== "failed") return { done: false, status: "rendering" };
  const outcome: RenderOutcome =
    state.status === "completed"
      ? { ok: true, videoUrl: state.videoUrl, durationS: state.durationS }
      : { ok: false, reason: state.failureMessage };
  const result = await completeRender(video.id, outcome, deps);
  if (result.status !== "already_done") return { done: true, status: result.status };
  return { done: true, status: (await deps.videos.getVideo(video.id))?.status ?? "unknown" };
}

/** The polling backup: every 30 s for up to 30 minutes (RENDER), then a plain failure. */
export async function pollRenderUntilDone(
  videoId: string,
  deps: CompleteDeps & { wait: (seconds: number) => Promise<void>; maxAttempts?: number },
): Promise<{ done: boolean; status: string }> {
  const maxAttempts = deps.maxAttempts ?? Math.ceil(RENDER.poll_max_s / RENDER.poll_every_s);
  for (let attempt = 1; ; attempt++) {
    const result = await pollRenderOnce(videoId, deps);
    if (result.done) return result;
    if (attempt >= maxAttempts) {
      const video = await deps.videos.getVideo(videoId);
      if (video && (await failRender(video, POLL_TIMEOUT, deps.videos))) return { done: true, status: "failed" };
      return { done: true, status: (await deps.videos.getVideo(videoId))?.status ?? "unknown" };
    }
    await deps.wait(RENDER.poll_every_s);
  }
}
