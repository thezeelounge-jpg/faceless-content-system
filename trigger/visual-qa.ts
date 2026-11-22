import { AbortTaskRunError, logger, schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";
import { runClaudeTask } from "../lib/claude";
import { createEditFiles } from "../lib/edit-store";
import { heygen } from "../lib/heygen";
import { createSpendStore } from "../lib/heygen-spend-store";
import { PlainError } from "../lib/plain-error";
import { VISUAL_QA } from "../lib/qa/config";
import { afterVisual, gateCrashed } from "../lib/qa/pipeline";
import { createPipelineStore } from "../lib/qa/pipeline-store";
import type { VisualGateOutcome } from "../lib/qa/visual-gate";
import { heygenCallbackUrl, renderVideo } from "../lib/render";
import { createVideoStore } from "../lib/video-store";
import { startNext } from "./next-step";

// Gate 5 (visual and realism QA, p5-b2) for one edit that passed Gate 4. All logic lives in
// lib/qa/visual-gate.ts and lib/qa/pipeline.ts; this task runs them and starts the next step:
// the one re-edit (edit-video, key edit-<video>-visual-1), the poll for the one re-render, or
// nothing (delivered, in the QA queue, or with the team). Started by technical-qa
// (key visual-qa-<video>-<edit run>, global). Claude goes through runClaudeTask (MOCK_CLAUDE unless
// exactly "false"). The re-render goes through renderVideo WITHOUT confirmSpend: in mock mode it
// renders (mock spend rows never counted); with real HeyGen it is refused before any paid call and
// waits for an admin's "Make video" + "I agree to spend" (as Gate 3).
// One ffmpeg pass decodes the 1080x1920 reel for the frames, so it gets 2 GB like Gate 4.

export const visualQaPayload = z.object({ videoId: z.string().uuid() });

export const VISUAL_QA_TASK = {
  machine: "medium-1x",
  // Seconds of compute: the frame pass (VISUAL_QA.extract_timeout_s) + one Claude call (180 s) + room.
  maxDuration: VISUAL_QA.extract_timeout_s + 180 + 300,
  retry: { maxAttempts: 2, minTimeoutInMs: 30_000, maxTimeoutInMs: 120_000, factor: 2 },
} as const;

/** The run failed for good (crash after the last retry, or a refusal) → a video still in final_qa (and its post) → team_review. */
export async function visualQaFailed({ payload, error }: { payload: { videoId: string }; error: unknown }): Promise<void> {
  await gateCrashed("visual", payload.videoId, error, createPipelineStore());
}

/** Gate 5, then start what comes next. */
export async function runVisualQa(videoId: string): Promise<VisualGateOutcome> {
  const { outcome, next } = await afterVisual(videoId, {
    store: createPipelineStore(),
    files: createEditFiles(),
    run: (task, ctx) => runClaudeTask(task, ctx),
    render: (id) => renderVideo(id, { videos: createVideoStore(), heygen: heygen(), spend: createSpendStore(), callbackUrl: heygenCallbackUrl() }),
  });
  logger.log("Gate 5 finished", { videoId, status: outcome.status });
  await startNext(next);
  return outcome;
}

export const visualQaTask = schemaTask({
  id: "visual-qa",
  schema: visualQaPayload,
  machine: VISUAL_QA_TASK.machine,
  maxDuration: VISUAL_QA_TASK.maxDuration,
  retry: VISUAL_QA_TASK.retry,
  onFailure: visualQaFailed,
  run: async ({ videoId }) => {
    try {
      return await runVisualQa(videoId);
    } catch (error) {
      if (error instanceof PlainError) throw new AbortTaskRunError(error.message);
      throw error;
    }
  },
});
