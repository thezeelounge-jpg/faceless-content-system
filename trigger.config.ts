import { defineConfig } from "@trigger.dev/sdk";

// Background jobs (renders, edits, QA, schedules) run on Trigger.dev.
// Replace the project ref below with yours: Trigger.dev dashboard > your
// project > Project settings. It starts with "proj_" and is not a secret.
export default defineConfig({
  project: "proj_REPLACE_WITH_YOUR_PROJECT_REF",
  dirs: ["./trigger"],
  maxDuration: 300, // seconds; long jobs (edits) set their own limit
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1_000,
      maxTimeoutInMs: 10_000,
      factor: 2,
      randomize: true,
    },
  },
});
