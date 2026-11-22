import { AbortTaskRunError, logger, schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";
import { runClaudeTask } from "../lib/claude";
import { createEditFiles } from "../lib/edit-store";
import { heygen } from "../lib/heygen";
import { createSpendStore } from "../lib/heygen-spend-store";
import { PlainError } from "../lib/plain-error";
import { afterRender, gateCrashed } from "../lib/qa/pipeline";
import { createPipelineStore } from "../lib/qa/pipeline-store";
import { heygenCallbackUrl, renderVideo } from "../lib/render";
import { createVideoStore } from "../lib/video-store";
import { startNext } from "./next-step";

// Gate 3 (audio and pronunciation QA) for one finished render. All logic lives in
// lib/qa/audio-gate.ts and lib/qa/pipeline.ts; this task runs them and starts the next step:
// the edit (passed), the poll for the one automatic re-render (failed once), or nothing (team).
// Started by poll-render (idempotency key audio-qa-<video id>, global).
// The re-render goes through renderVideo WITHOUT confirmSpend: in mock mode it renders (spend
// guard, mock rows never counted); with real HeyGen it is refused before any paid call and waits
// for an admin's "Make video" + "I agree to spend" (lib/qa/audio-gate.ts).

export const audioQaPayload = z.object({ videoId: z.string().uuid() });

export const AUDIO_QA_TASK = {
  // Light work: one speech-to-text call (mock now), one ffmpeg pass over the audio, one Claude FAST call.
  machine: "medium-1x",
  maxDuration: 600,
  retry: { maxAttempts: 3, minTimeoutInMs: 30_000, maxTimeoutInMs: 300_000, factor: 2 },
} as const;

/**
 * p5-b1 (QA SF1): Trigger.dev calls onFailure once the run failed and will not be retried
 * (crash after the last retry, or AbortTaskRunError). A video still in audio_qa (and its post)
 * goes to team_review with a plain reason (lib/qa/pipeline.ts gateCrashed), never left stuck.
 */
export async function audioQaFailed({ payload, error }: { payload: { videoId: string }; error: unknown }): Promise<void> {
  await gateCrashed("audio", payload.videoId, error, createPipelineStore());
}

export const audioQaTask = schemaTask({
  id: "audio-qa",
  schema: audioQaPayload,
  machine: AUDIO_QA_TASK.machine,
  maxDuration: AUDIO_QA_TASK.maxDuration,
  retry: AUDIO_QA_TASK.retry,
  onFailure: audioQaFailed,
  run: async ({ videoId }) => {
    try {
      const { outcome, next } = await afterRender(videoId, {
        store: createPipelineStore(),
        files: createEditFiles(),
        run: (task, ctx) => runClaudeTask(task, ctx),
        render: (id) =>
          renderVideo(id, { videos: createVideoStore(), heygen: heygen(), spend: createSpendStore(), callbackUrl: heygenCallbackUrl() }),
      });
      logger.log("Gate 3 finished", { videoId, status: outcome.status });
      await startNext(next);
      return outcome;
    } catch (error) {
      if (error instanceof PlainError) throw new AbortTaskRunError(error.message);
      throw error;
    }
  },
});
