import { AbortTaskRunError, logger, schemaTask } from "@trigger.dev/sdk";
import { editJobSchema, runEditJob, runFfmpeg } from "../lib/edit-flow";
import { createEditFiles, createEditStore } from "../lib/edit-store";
import { PlainError } from "../lib/plain-error";
import { EDIT } from "../lib/qa/config";
import { afterEditTask, resyncAfterEdit, type NextTask } from "../lib/qa/pipeline";
import { createPipelineStore } from "../lib/qa/pipeline-store";
import { startNext } from "./next-step";

// The editor (Phase 4): raw HeyGen MP4 → 1080x1920, 30 fps reel with
// word-by-word captions. All logic lives in lib/edit-flow.ts (runEditJob),
// which saves the result or a plain error on the video row itself.
//
// Started by the QA pipeline (p5-a2, lib/qa/pipeline.ts): audio-qa after Gate 3 passes
// (key `edit-<video id>-1`) and technical-qa for the one rebuild (`edit-<video id>-rebuild-1`),
// both global idempotency keys, so a retry of the caller never makes two edits.
// When the edit reaches final_qa it starts Gate 4 (technical-qa).
// Needs ffmpeg with libass (`subtitles` filter): trigger.config.ts adds the
// ffmpeg build extension and copies assets/fonts (additionalFiles).
// Check on the first deploy that the apt ffmpeg has the subtitles filter.

export const editVideoPayload = editJobSchema;

export const EDIT_TASK = {
  // 4 vCPU / 8 GB (docs: trigger.dev/docs/machines). x264 uses every core;
  // CLAUDE.md asks for 2 GB or more for edits. "Killed for memory" → large-2x.
  machine: "large-1x",
  // Seconds of compute. Above EDIT.ffmpeg_timeout_s (900) plus download/upload.
  // Also the edit-claim stale limit (EDIT.claim_stale_s, p4-b1).
  maxDuration: EDIT.task_max_duration_s,
  // Only crashes are retried (machine lost, out of memory). A failed edit is
  // already saved on the row for the team; refusals are never retried.
  retry: { maxAttempts: 2, minTimeoutInMs: 30_000, maxTimeoutInMs: 120_000, factor: 2 },
} as const;

/**
 * p5-b1 (Rowan 4): after every edit run (and after a refused retry), re-sync a post stuck in
 * 'editing' when the video's file is already saved and promoted (lib/qa/pipeline.ts
 * resyncAfterEdit), then start Gate 4. The re-sync hands back the same global key as
 * afterEditTask for that edit run, so Gate 4 starts once however often this runs.
 */
export async function syncAfterEdit(videoId: string, next: NextTask | null): Promise<void> {
  let toStart = next;
  try {
    toStart = (await resyncAfterEdit(videoId, createPipelineStore())).next ?? next;
  } catch (error) {
    logger.warn("Could not re-sync the post after the edit", { videoId, error: error instanceof Error ? error.message : String(error) });
  }
  await startNext(toStart);
}

export const editVideoTask = schemaTask({
  id: "edit-video",
  schema: editVideoPayload,
  machine: EDIT_TASK.machine,
  maxDuration: EDIT_TASK.maxDuration,
  retry: EDIT_TASK.retry,
  run: async (payload, { ctx }) => {
    try {
      const outcome = await runEditJob(payload, {
        store: createEditStore(),
        files: createEditFiles(),
        ffmpeg: runFfmpeg,
        // p4-b1: the claim token. A retry of this run keeps the same run id, so it may re-claim;
        // any other run is refused while this claim is fresh.
        runToken: ctx.run.id,
      });
      logger.log("Edit finished", { videoId: payload.videoId, status: outcome.status });
      // p5-a2: an edit that reached final_qa goes to Gate 4 (technical-qa), one key per edit run.
      // p5-b1 (Rowan 4): and a post left in 'editing' after the promotion is re-synced first.
      await syncAfterEdit(payload.videoId, afterEditTask(outcome, payload.videoId, ctx.run.id));
      return outcome;
    } catch (error) {
      // "This video can't be edited: ..." won't fix itself. (p5-b1: a retry refused because the
      // edit already finished still re-syncs the post and starts Gate 4 with the same key.)
      if (error instanceof PlainError) {
        await syncAfterEdit(payload.videoId, null).catch((e) =>
          logger.warn("Could not start Gate 4 after a refused edit", { videoId: payload.videoId, error: e instanceof Error ? e.message : String(e) }),
        );
        throw new AbortTaskRunError(error.message);
      }
      throw error;
    }
  },
});
