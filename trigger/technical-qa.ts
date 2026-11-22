import { AbortTaskRunError, logger, schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";
import { createEditFiles } from "../lib/edit-store";
import { PlainError } from "../lib/plain-error";
import { TECH_QA } from "../lib/qa/config";
import { afterEdit } from "../lib/qa/pipeline";
import { createPipelineStore } from "../lib/qa/pipeline-store";
import { startNext } from "./next-step";

// Gate 4 (technical QA) for one finished edit. All logic lives in lib/qa/technical-gate.ts and
// lib/qa/pipeline.ts; this task runs them and starts the one rebuild of the edit when the first
// check fails. Passed = ready for Gate 5 (part 5b). Started by edit-video (key technical-qa-<video>-<edit run>).
// ffmpeg decodes the whole 1080x1920 reel (black/freeze/loudness), so it gets 2 GB.

export const technicalQaPayload = z.object({ videoId: z.string().uuid() });

export const TECHNICAL_QA_TASK = {
  machine: "medium-1x",
  // Seconds of compute: the final pass and two stem passes, each under TECH_QA.measure_timeout_s.
  maxDuration: TECH_QA.measure_timeout_s * 3 + 300,
  retry: { maxAttempts: 2, minTimeoutInMs: 30_000, maxTimeoutInMs: 120_000, factor: 2 },
} as const;

export const technicalQaTask = schemaTask({
  id: "technical-qa",
  schema: technicalQaPayload,
  machine: TECHNICAL_QA_TASK.machine,
  maxDuration: TECHNICAL_QA_TASK.maxDuration,
  retry: TECHNICAL_QA_TASK.retry,
  run: async ({ videoId }) => {
    try {
      const { outcome, next } = await afterEdit(videoId, { store: createPipelineStore(), files: createEditFiles() });
      logger.log("Gate 4 finished", { videoId, status: outcome.status });
      await startNext(next);
      return outcome;
    } catch (error) {
      if (error instanceof PlainError) throw new AbortTaskRunError(error.message);
      throw error;
    }
  },
});
