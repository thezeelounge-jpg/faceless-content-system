import { logger, task } from "@trigger.dev/sdk";
import { isMockHeygen, isMockStt } from "../lib/config";

// Phase 1 test job: proves the app can start background jobs.
// Start it from Admin > Settings > "Run test job".
export const helloWorld = task({
  id: "hello-world",
  maxDuration: 60,
  run: async (payload: { startedFrom?: string }) => {
    const result = {
      message: "Hello from Creator Tool",
      startedFrom: payload.startedFrom ?? "unknown",
      mockHeygen: isMockHeygen(),
      mockStt: isMockStt(),
      finishedAt: new Date().toISOString(),
    };
    logger.log("Test job ran", result);
    return result;
  },
});
