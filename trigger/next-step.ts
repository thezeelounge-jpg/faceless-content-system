import { idempotencyKeys, logger, tasks } from "@trigger.dev/sdk";
import type { NextTask } from "../lib/qa/pipeline";

// Starts the next pipeline step (lib/qa/pipeline.ts decides which). By task id, not by importing
// the task, so the task files never import each other in a circle. The key is a GLOBAL idempotency
// key: a retry of the calling task (or a double webhook/poll) never starts the same step twice.

export async function startNext(next: NextTask | null): Promise<void> {
  if (!next) return;
  const idempotencyKey = await idempotencyKeys.create(next.key, { scope: "global" });
  await tasks.trigger(next.taskId, next.payload, { idempotencyKey });
  logger.log("Next pipeline step started", { taskId: next.taskId, key: next.key });
}
