import { AbortTaskRunError, logger, schemaTask } from "@trigger.dev/sdk";
import { editJobSchema, runEditJob, runFfmpeg } from "../lib/edit-flow";
import { createEditFiles, createEditStore } from "../lib/edit-store";
import { PlainError } from "../lib/plain-error";

// The editor (Phase 4): raw HeyGen MP4 → 1080x1920, 30 fps reel with
// word-by-word captions. All logic lives in lib/edit-flow.ts (runEditJob),
// which saves the result or a plain error on the video row itself.
//
// Not started automatically yet: Phase 5's pipeline (after Gate 3) will
// trigger it with idempotency key `edit-<video id>-<attempt>` (scope global),
// so a double click or a retry of the caller never makes two edits.
// Needs ffmpeg with libass (`subtitles` filter): trigger.config.ts adds the
// ffmpeg build extension and copies assets/fonts (additionalFiles).
// Check on the first deploy that the apt ffmpeg has the subtitles filter.

export const editVideoPayload = editJobSchema;

export const EDIT_TASK = {
  // 4 vCPU / 8 GB (docs: trigger.dev/docs/machines). x264 uses every core;
  // CLAUDE.md asks for 2 GB or more for edits. "Killed for memory" → large-2x.
  machine: "large-1x",
  // Seconds of compute. Above EDIT.ffmpeg_timeout_s (900) plus download/upload.
  maxDuration: 1800,
  // Only crashes are retried (machine lost, out of memory). A failed edit is
  // already saved on the row for the team; refusals are never retried.
  retry: { maxAttempts: 2, minTimeoutInMs: 30_000, maxTimeoutInMs: 120_000, factor: 2 },
} as const;

export const editVideoTask = schemaTask({
  id: "edit-video",
  schema: editVideoPayload,
  machine: EDIT_TASK.machine,
  maxDuration: EDIT_TASK.maxDuration,
  retry: EDIT_TASK.retry,
  run: async (payload) => {
    try {
      const outcome = await runEditJob(payload, {
        store: createEditStore(),
        files: createEditFiles(),
        ffmpeg: runFfmpeg,
      });
      logger.log("Edit finished", { videoId: payload.videoId, status: outcome.status });
      return outcome;
    } catch (error) {
      // "This video can't be edited: ..." won't fix itself.
      if (error instanceof PlainError) throw new AbortTaskRunError(error.message);
      throw error;
    }
  },
});
