import { logger, schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";
import { runClipCheckJob } from "../lib/consent-flow";
import { createClipStorage, createConsentStore } from "../lib/consent-store";

// Decision 2: the automatic consent-clip checks (ffprobe/ffmpeg, .mov → mp4,
// the Claude face check) run here instead of inside a Server Action. Started
// by Admin → Consent → upload / "Run checks" with idempotency key = consent id
// + clip path. All logic lives in lib/consent-flow.ts (runClipCheckJob), which
// saves clip_check_status (running → done | failed) for the page.
// Needs ffmpeg: trigger.config.ts adds the ffmpeg build extension.

export const checkClipPayload = z.object({
  consentId: z.string().uuid(),
  // brand/consent/uuid.ext, as made by prepareUpload (re-checked in lib).
  clipPath: z
    .string()
    .max(300)
    .regex(/^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(mp4|webm|mov)$/i),
});

export const checkClipTask = schemaTask({
  id: "check-clip",
  schema: checkClipPayload,
  maxDuration: 600, // seconds: download up to 50 MB, maybe convert, measure, 6 frames to Claude
  machine: "medium-1x", // 2 GB: ffmpeg re-encodes a .mov
  retry: { maxAttempts: 2, minTimeoutInMs: 10_000, maxTimeoutInMs: 60_000, factor: 2 },
  run: async ({ consentId, clipPath }) => {
    const outcome = await runClipCheckJob(consentId, clipPath, {
      store: createConsentStore(),
      storage: createClipStorage(),
    });
    logger.log("Clip check finished", { consentId, ...outcome });
    return outcome;
  },
});
