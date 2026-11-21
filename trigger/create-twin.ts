import { logger, schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";
import { createClipStorage, createConsentStore } from "../lib/consent-store";
import { heygen } from "../lib/heygen";
import { createSpendStore } from "../lib/heygen-spend-store";
import { createTwin } from "../lib/twin";
import { pollTwinTask } from "./poll-twin";

// Started by Admin → Consents and twins → Approve, with idempotency key =
// the consent id, so one approval makes at most one twin. All logic lives in
// lib/twin.ts (createTwin refuses unless the consent is approved).
// Mock mode (MOCK_HEYGEN not exactly "false") calls nothing and spends nothing.

export const twinPayload = z.object({ consentId: z.string().uuid() });

export const createTwinTask = schemaTask({
  id: "create-twin",
  schema: twinPayload,
  maxDuration: 900, // seconds: downloading and uploading a clip up to 200 MB
  retry: { maxAttempts: 3, minTimeoutInMs: 10_000, maxTimeoutInMs: 120_000, factor: 2 },
  run: async ({ consentId }) => {
    const avatar = await createTwin(consentId, {
      store: createConsentStore(),
      storage: createClipStorage(),
      heygen: heygen(),
      spend: createSpendStore(),
    });
    logger.log("Twin created on HeyGen, waiting for consent", { consentId, avatarId: avatar.id });
    await pollTwinTask.trigger({ avatarId: avatar.id }, { idempotencyKey: `poll-twin-${avatar.id}` });
    return { avatarId: avatar.id, status: avatar.status };
  },
});
