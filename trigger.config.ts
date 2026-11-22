import { additionalFiles, ffmpeg } from "@trigger.dev/build/extensions/core";
import { defineConfig } from "@trigger.dev/sdk";

// Background jobs (renders, edits, QA, schedules) run on Trigger.dev.
// Replace the project ref below with yours: Trigger.dev dashboard > your
// project > Project settings. It starts with "proj_" and is not a secret.
export default defineConfig({
  project: "proj_jhdkwttfovsdwgohzkxf",
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
  build: {
    // ffmpeg + ffprobe for the clip checks (and Phase 4 edits). The extension
    // sets FFMPEG_PATH and FFPROBE_PATH, which lib/clip-checks/media.ts reads.
    // (@trigger.dev/build/extensions/core: "Add ffmpeg to the build, and
    // automatically set the FFMPEG_PATH and FFPROBE_PATH environment variables.")
    // Phase 4: additionalFiles copies the caption fonts into the build ("The
    // output paths will match the path of the file, relative to the root of the
    // project"); the edit task reads path.join(process.cwd(), "assets/fonts").
    extensions: [ffmpeg(), additionalFiles({ files: ["./assets/fonts/**"] })],
    // Our lib/ files start with `import "server-only"`, which throws unless the
    // "react-server" condition is on (server-only/package.json maps it to an
    // empty file). BuildConfig.conditions: "Add custom conditions to the esbuild
    // build" (@trigger.dev/core v3/config.d.ts). Check the first deploy log.
    conditions: ["react-server"],
  },
});
