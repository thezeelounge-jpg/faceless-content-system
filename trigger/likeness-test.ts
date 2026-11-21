import { AbortTaskRunError, idempotencyKeys, logger, schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";
import { createConsentStore } from "../lib/consent-store";
import { heygen } from "../lib/heygen";
import { prepareLikenessTest } from "../lib/likeness";
import { PlainError } from "../lib/plain-error";
import { createVideoStore } from "../lib/video-store";
import { renderVideoTask } from "./render-video";

// Started by Admin → Consents and twins → twin → "Likeness test" (key = twin
// id, 10-minute TTL). lib/likeness.ts checks the rules (twin in likeness_test,
// HeyGen consent accepted, the admin's confirmSpend for real renders) and
// makes one queued video per realistic engine; then one render-video run per
// video (key = video id), so each goes through the same render path.

export const likenessPayload = z.object({
  avatarId: z.string().uuid(),
  confirmSpend: z.boolean().optional(),
});

export const likenessTestTask = schemaTask({
  id: "likeness-test",
  schema: likenessPayload,
  maxDuration: 120,
  retry: { maxAttempts: 2, minTimeoutInMs: 10_000, maxTimeoutInMs: 60_000, factor: 2 },
  run: async ({ avatarId, confirmSpend }) => {
    let videos;
    try {
      videos = await prepareLikenessTest(avatarId, {
        store: createConsentStore(),
        videos: createVideoStore(),
        heygen: heygen(),
        confirmSpend: confirmSpend === true,
      });
    } catch (error) {
      if (error instanceof PlainError) throw new AbortTaskRunError(error.message);
      throw error;
    }
    for (const video of videos) {
      const idempotencyKey = await idempotencyKeys.create(`render-${video.id}`, { scope: "global" });
      await renderVideoTask.trigger({ videoId: video.id, confirmSpend: confirmSpend === true }, { idempotencyKey });
    }
    logger.log("Likeness test renders started", { avatarId, videos: videos.map((v) => v.id) });
    return { videoIds: videos.map((v) => v.id) };
  },
});
