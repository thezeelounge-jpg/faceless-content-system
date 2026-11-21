import { logger, schemaTask, wait } from "@trigger.dev/sdk";
import { z } from "zod";
import { heygen } from "../lib/heygen";
import { pollRenderUntilDone } from "../lib/render";
import { createVideoFiles, createVideoStore } from "../lib/video-store";

// The polling backup for HeyGen webhooks (a callback is attempted once):
// GET /v3/videos/{id} every 30 s for up to 30 minutes (lib/qa/config.ts
// RENDER), then the same success/failure handling as the webhook
// (lib/render.ts). A video the webhook already finished is skipped.

export const pollRenderPayload = z.object({ videoId: z.string().uuid() });

export const pollRenderTask = schemaTask({
  id: "poll-render",
  schema: pollRenderPayload,
  maxDuration: 600, // seconds of compute (downloads included); waiting does not count
  retry: { maxAttempts: 3, minTimeoutInMs: 30_000, maxTimeoutInMs: 300_000, factor: 2 },
  run: async ({ videoId }) => {
    const result = await pollRenderUntilDone(videoId, {
      videos: createVideoStore(),
      heygen: heygen(),
      files: createVideoFiles(),
      wait: (seconds) => wait.for({ seconds }),
    });
    logger.log("Render polling finished", { videoId, ...result });
    return result;
  },
});
