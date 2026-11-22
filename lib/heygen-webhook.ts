import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { logAdminError } from "@/lib/admin-errors";
import { completeRender, pollRenderOnce, type CompleteDeps } from "@/lib/render";

// HeyGen webhooks (Phase 3 item 8). Docs ("Webhooks", "Webhook Events"):
// - header `signature` = hex HMAC-SHA256 of the RAW body, keyed with the
//   endpoint secret (HEYGEN_WEBHOOK_SECRET). No timestamp is documented.
// - envelope { event_type, event_data }; avatar_video.success event_data has
//   video_id, url, callback_id (and gif/page links). avatar_video.fail fields
//   are UNCONFIRMED: we read `msg` (older docs) and fall back to a plain default.
// - No duration in the payload: GET /v3/videos/{id} gives it (and a fresh URL).
// - Respond 2xx within 10 s; HeyGen retries with backoff for up to 24 h and
//   may send the same event twice. We dedupe on event_type + video_id (the
//   docs' advice), so a callback_url delivery and a registered-endpoint
//   delivery of the same event count once.
// Checks in order: secret set (503), signature (401, nothing stored), JSON
// (400), store the event once (webhook_events, unique event_key), process.
// A processing error answers 500 and leaves the event unprocessed, so
// HeyGen's retry (or the polling backup) finishes it later.

export type WebhookResult = { status: number; body: { ok: boolean; message: string } };

const HANDLED_EVENTS = ["avatar_video.success", "avatar_video.fail"] as const;

const eventSchema = z.object({
  event_type: z.string(),
  event_data: z
    .object({
      video_id: z.string().min(1).max(200),
      callback_id: z.string().max(256).nullish(),
      url: z.string().max(4000).nullish(),
      msg: z.string().max(2000).nullish(),
    })
    .passthrough(),
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX = /^[0-9a-f]+$/i;

const answer = (status: number, ok: boolean, message: string): WebhookResult => ({ status, body: { ok, message } });

/** HeyGen's id for a log line: plain id characters only, short. */
const logSafe = (value: string) => value.replace(/[^\w.-]/g, "?").slice(0, 100);

/** Constant-time check of HeyGen's hex HMAC-SHA256 signature. Never throws. */
export function verifyHeygenSignature(rawBody: string, signature: string | null, secret: string): boolean {
  if (!signature || !secret) return false;
  const given = signature.trim().toLowerCase();
  if (!HEX.test(given)) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export type WebhookDeps = CompleteDeps & {
  /** With Trigger.dev set up: hand the download to a background task (HeyGen wants an answer within 10 s). */
  finishInBackground?: (videoId: string, eventKey: string) => Promise<void>;
};

export async function handleHeygenWebhook(
  input: { rawBody: string; signature: string | null; secret: string | undefined },
  deps: WebhookDeps,
): Promise<WebhookResult> {
  if (!input.secret) return answer(503, false, "HeyGen webhooks are not set up yet.");
  if (!verifyHeygenSignature(input.rawBody, input.signature, input.secret)) return answer(401, false, "Bad signature.");

  let json: unknown;
  try {
    json = JSON.parse(input.rawBody);
  } catch {
    return answer(400, false, "Not JSON.");
  }
  const parsed = eventSchema.safeParse(json);
  if (!parsed.success || !(HANDLED_EVENTS as readonly string[]).includes(parsed.data.event_type)) {
    return answer(200, true, "Ignored (not a video event we use).");
  }
  const { event_type: type, event_data: data } = parsed.data;
  const eventKey = `heygen:${type}:${data.video_id}`;

  try {
    const saved = await deps.videos.saveWebhookEvent(eventKey, json);
    if (saved === "processed") return answer(200, true, "Already handled.");

    // callback_id is our video id; the HeyGen id must match when we have it.
    let video = data.callback_id && UUID.test(data.callback_id) ? await deps.videos.getVideo(data.callback_id) : null;
    if (video && video.heygen_video_id && video.heygen_video_id !== data.video_id) video = null;
    video ??= await deps.videos.getVideoByHeygenId(data.video_id);
    if (!video) {
      await deps.videos.markWebhookProcessed(eventKey);
      return answer(200, true, "Unknown video (ignored).");
    }
    // p4-fix c2: HeyGen finished a render AFTER we gave up on it (an admin cleared the claim, or
    // the 30-minute wait ran out). It was paid for: never ignore it silently. adopt_late_render
    // decides atomically: adopt it (id saved, back to 'rendering', downloaded below) or, when a
    // newer render exists, only record the late id. It never reserves spend, never writes a
    // provider_usage row and never starts a render. A cleared row is never claimed again, so
    // this callback can only be the old render.
    if (type === "avatar_video.success" && !video.heygen_video_id && video.status === "failed") {
      const late = await deps.videos.adoptLateRender(video.id, data.video_id);
      const ids = `video=${video.id} heygen=${logSafe(data.video_id)}`;
      if (late === "moved_on") {
        console.warn(`[webhook] late HeyGen success recorded (a newer render was kept) ${ids}`);
        await deps.videos.markWebhookProcessed(eventKey);
        return answer(200, true, "Late video recorded; a newer render was kept.");
      }
      if (late === "adopted") console.warn(`[webhook] late HeyGen success adopted ${ids}`);
    } else if (type === "avatar_video.fail" && !video.heygen_video_id && video.status === "failed") {
      console.warn(`[webhook] late HeyGen failure for a video we already gave up on video=${video.id} (nothing to do)`);
    }

    // The webhook beat us to saving HeyGen's id (POST answered, our save not done yet).
    if (!video.heygen_video_id && video.status === "rendering") {
      await deps.videos.updateVideo(video.id, { heygen_video_id: data.video_id });
    }

    if (type === "avatar_video.fail") {
      await completeRender(video.id, { ok: false, reason: data.msg ?? null }, deps);
    } else if (deps.finishInBackground) {
      await deps.finishInBackground(video.id, eventKey);
    } else {
      // GET /v3/videos/{id} for the duration and a fresh URL; the payload URL is the fallback.
      const polled = await pollRenderOnce(video.id, deps);
      if (!polled.done) await completeRender(video.id, { ok: true, videoUrl: data.url ?? null, durationS: null }, deps);
    }
    await deps.videos.markWebhookProcessed(eventKey);
    return answer(200, true, "Handled.");
  } catch (error) {
    logAdminError("[webhook] heygen event failed", { eventKey }, error);
    return answer(500, false, "Could not handle the event. It will be tried again.");
  }
}
