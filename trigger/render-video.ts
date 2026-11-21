import { AbortTaskRunError, idempotencyKeys, logger, queue, schemaTask, wait } from "@trigger.dev/sdk";
import { z } from "zod";
import { HeygenError, heygen } from "../lib/heygen";
import { createSpendStore } from "../lib/heygen-spend-store";
import { PlainError } from "../lib/plain-error";
import { RENDER } from "../lib/qa/config";
import { heygenCallbackUrl, renderVideo } from "../lib/render";
import { createVideoStore } from "../lib/video-store";
import { pollRenderTask } from "./poll-render";

// Sends one queued video to HeyGen (POST /v3/videos). All logic lives in
// lib/render.ts: the money rules (mock, the admin's confirmSpend, the spend
// guard with both pause switches and the daily cap), the claim that stops a
// second paid render, and the 10-at-once cap. Started by an admin Server
// Action with idempotency key = our video id.
// When all 10 slots are busy, this task waits (wait.for does not use compute)
// and tries again; the video stays queued and the post is never errored.
// After the POST it starts the poll-render backup (webhooks are attempted once).
// SF3: when the POST answer was lost (timeout/5xx), renderVideo returns
// "unknown" instead of throwing (no retry, never a second POST); the poll
// still starts, waits for the webhook to tell us HeyGen's id, and hands the
// video to the team after RENDER.poll_max_s (SF5).

export const renderQueue = queue({ name: "heygen-renders", concurrencyLimit: RENDER.max_concurrent });

export const renderPayload = z.object({
  videoId: z.string().uuid(),
  /** The admin ticked "I agree to spend" (required when MOCK_HEYGEN is "false"). */
  confirmSpend: z.boolean().optional(),
});

export const renderVideoTask = schemaTask({
  id: "render-video",
  schema: renderPayload,
  queue: renderQueue,
  maxDuration: 300, // seconds of compute; waiting for a free slot does not count
  retry: { maxAttempts: 3, minTimeoutInMs: 30_000, maxTimeoutInMs: 300_000, factor: 2 },
  run: async ({ videoId, confirmSpend }) => {
    const deps = {
      videos: createVideoStore(),
      heygen: heygen(),
      spend: createSpendStore(),
      confirmSpend: confirmSpend === true,
      callbackUrl: heygenCallbackUrl(),
    };
    for (let waits = 0; ; waits++) {
      let result;
      try {
        result = await renderVideo(videoId, deps);
      } catch (error) {
        // Plain refusals (paused, no confirm, wrong engine, lost render) won't fix themselves:
        // don't retry. HeyGen "busy" or "failed" may: let Trigger.dev retry.
        const retryable = error instanceof HeygenError && (error.code === "busy" || error.code === "failed");
        if (error instanceof PlainError && !retryable) throw new AbortTaskRunError(error.message);
        throw error;
      }
      if (result.status !== "waiting") {
        const idempotencyKey = await idempotencyKeys.create(`poll-render-${videoId}`, { scope: "global" });
        await pollRenderTask.trigger({ videoId }, { idempotencyKey });
        logger.log("Render started on HeyGen", { videoId, status: result.status });
        return result;
      }
      if (waits >= RENDER.busy_max_waits) {
        logger.warn("All render slots stayed busy; the video stays queued", { videoId });
        return result;
      }
      await wait.for({ seconds: RENDER.busy_wait_s });
    }
  },
});
