import { logger, schemaTask, wait } from "@trigger.dev/sdk";
import { z } from "zod";
import { createConsentStore } from "../lib/consent-store";
import { heygen } from "../lib/heygen";
import { pollTwinUntilReady } from "../lib/twin";

// Waits until the person has accepted HeyGen's consent and the twin is
// trained, then saves the look id, voice id and supported engines
// (lib/twin.ts). Bounded: backs off from 1 minute to 30 minutes, at most
// TWIN_POLL.max_attempts checks. wait.for does not use compute while waiting.

export const pollPayload = z.object({ avatarId: z.string().uuid() });

export const pollTwinTask = schemaTask({
  id: "poll-twin",
  schema: pollPayload,
  maxDuration: 600, // seconds of compute; waiting time does not count
  retry: { maxAttempts: 3, minTimeoutInMs: 30_000, maxTimeoutInMs: 300_000, factor: 2 },
  run: async ({ avatarId }) => {
    const result = await pollTwinUntilReady(avatarId, {
      store: createConsentStore(),
      heygen: heygen(),
      wait: (seconds) => wait.for({ seconds }),
    });
    logger.log("Twin polling finished", { avatarId, ...result });
    return result;
  },
});
