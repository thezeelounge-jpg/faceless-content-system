import { describe, expect, it } from "vitest";
import config from "@/trigger.config";

// Rowan's decision 1: trigger.config.ts gains ONLY the ffmpeg build extension
// and the "react-server" condition (so `import "server-only"` resolves to
// server-only's empty.js inside tasks instead of throwing). Nothing else moves.

describe("trigger.config.ts", () => {
  it("keeps the project ref, task folder and limits", () => {
    expect(config.project).toBe("proj_jhdkwttfovsdwgohzkxf");
    expect(config.dirs).toEqual(["./trigger"]);
    expect(config.maxDuration).toBe(300);
    expect(config.retries?.default?.maxAttempts).toBe(3);
  });

  it("adds the ffmpeg build extension (sets FFMPEG_PATH and FFPROBE_PATH)", () => {
    expect(config.build?.extensions?.map((e) => e.name)).toEqual(["ffmpeg"]);
  });

  it("adds the react-server condition so server-only does not throw in tasks", () => {
    expect(config.build?.conditions).toEqual(["react-server"]);
  });
});
