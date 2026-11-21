import { spawnSync } from "node:child_process";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeBrand } from "@/lib/claude";
import { evaluateClip, type FaceFrames } from "@/lib/clip-checks/evaluate";
import type { ClipMeasurements } from "@/lib/clip-checks/media";
import { runClipChecks } from "@/lib/clip-checks/run";
import { CLIP_CHECKS } from "@/lib/qa/config";

const GOOD_M: ClipMeasurements = {
  durationS: 120,
  width: 1080,
  height: 1920,
  fps: 29.97,
  hasAudio: true,
  loudnessLufs: -18,
  longestSilenceS: 1.2,
  brightness: 130,
};
const ONE_FACE: FaceFrames = Array.from({ length: 6 }, () => ({ faces: 1, face_clear: true }));
const NOW = new Date("2026-11-22T10:00:00.000Z");

const failed = (result: ReturnType<typeof evaluateClip>) => result.checks.filter((c) => !c.passed).map((c) => c.code);

describe("thresholds live in lib/qa/config.ts", () => {
  it("HeyGen's duration limits (15 to 600 s) and our quality bar", () => {
    expect(CLIP_CHECKS).toMatchObject({
      min_duration_s: 15,
      max_duration_s: 600,
      min_short_side_px: 1080,
      face_frames: 6,
    });
  });
});

describe("evaluateClip", () => {
  it("a good clip passes every check, with no tips", () => {
    const result = evaluateClip(GOOD_M, ONE_FACE, NOW);
    expect(result.passed).toBe(true);
    expect(result.checks.map((c) => c.code)).toEqual([
      "duration", "resolution", "fps", "loudness", "silence", "light", "one_face", "face_clear",
    ]);
    expect(result.checks.every((c) => c.passed && c.tip === null)).toBe(true);
    expect(result.tips).toEqual([]);
    expect(result.checked_at).toBe("2026-11-22T10:00:00.000Z");
  });

  it.each([
    ["duration", { durationS: 9 }, "Record one continuous take of about 2 minutes (at least 15 seconds)."],
    ["duration", { durationS: 700 }, "Keep the clip under 10 minutes. About 2 minutes is best."],
    ["resolution", { width: 720, height: 1280 }, "Film at 1080p or 4K with the phone's back camera."],
    ["fps", { fps: 15 }, "Set the camera to 30 frames per second."],
    ["loudness", { loudnessLufs: -45 }, "Speak up, or keep the phone within an arm's length. A clip-on microphone is best."],
    ["loudness", { loudnessLufs: -2 }, "The sound is too loud. Move the microphone a little further away."],
    ["loudness", { hasAudio: false, loudnessLufs: null }, "We couldn't hear you. Check the microphone is on and record again."],
    ["silence", { longestSilenceS: 6 }, "Keep talking the whole time. Pause for only one second every few sentences."],
    ["light", { brightness: 30 }, "Face a window in daylight, or put one soft light in front of you. No bright light behind you."],
    ["light", { brightness: 240 }, "The picture is too bright. Move away from direct sun or turn the light down."],
  ] as const)("%s fails with a plain tip (%o)", (code, change, tip) => {
    const result = evaluateClip({ ...GOOD_M, ...change }, ONE_FACE, NOW);
    expect(result.passed).toBe(false);
    expect(failed(result)).toEqual([code]);
    expect(result.checks.find((c) => c.code === code)?.tip).toBe(tip);
    expect(result.tips).toEqual([tip]);
  });

  it("two faces in any frame fails one_face", () => {
    const frames = ONE_FACE.map((f, i) => (i === 2 ? { faces: 2, face_clear: false } : f));
    const result = evaluateClip(GOOD_M, frames, NOW);
    expect(failed(result)).toEqual(["one_face"]);
    expect(result.tips).toEqual(["Only you should be in the clip. Nobody else, and no photos or screens with faces."]);
  });

  it("no face in a frame fails one_face with a framing tip", () => {
    const frames = ONE_FACE.map((f, i) => (i === 0 ? { faces: 0, face_clear: false } : f));
    expect(evaluateClip(GOOD_M, frames, NOW).tips).toEqual([
      "Stay in the frame the whole time, from the top of your head to the middle of your chest.",
    ]);
  });

  it("one unclear frame is allowed; two are not", () => {
    const one = ONE_FACE.map((f, i) => (i === 1 ? { ...f, face_clear: false } : f));
    expect(evaluateClip(GOOD_M, one, NOW).passed).toBe(true);
    const two = one.map((f, i) => (i === 4 ? { ...f, face_clear: false } : f));
    expect(evaluateClip(GOOD_M, two, NOW).tips).toEqual([
      "Keep your face bright, sharp and fully visible: hair off your face, no hat or sunglasses, hands below your chin.",
    ]);
  });

  it("missing face results (Claude not run) fail safe", () => {
    expect(failed(evaluateClip(GOOD_M, [], NOW))).toEqual(["one_face", "face_clear"]);
  });
});

// Real ffprobe/ffmpeg on the fixture clips, with the mock face check (MOCK_CLAUDE).
const hasFfmpeg =
  spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;

const BRAND: ClaudeBrand = {
  id: null, name: "Test", niche: null, audience: null, offers: null, tone: null, sound_answers: {},
  samples: null, banned_words: [], language: "en", profile_md: null, pillars: [], words_per_second: 2.4,
};

describe.skipIf(!hasFfmpeg)("runClipChecks on the fixtures (real ffmpeg + mock vision)", () => {
  const logUsage = vi.fn(async () => {});
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network is not allowed in tests"));
  });
  afterEach(() => vi.restoreAllMocks());

  it("good clip passes every check", async () => {
    const result = await runClipChecks(path.resolve("tests/fixtures/consent-good.mp4"), {
      brand: BRAND,
      clipName: "consent-good.mp4",
      claude: { mock: true, logUsage },
      now: NOW,
    });
    expect(result.checks.filter((c) => !c.passed)).toEqual([]);
    expect(result.passed).toBe(true);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("bad clip (dark, small, short, silent gap, two faces) fails with the right tips", async () => {
    const result = await runClipChecks(path.resolve("tests/fixtures/consent-bad.mp4"), {
      brand: BRAND,
      clipName: "consent-bad.mp4",
      claude: { mock: true, logUsage },
      now: NOW,
    });
    expect(result.passed).toBe(false);
    expect(failed(result)).toEqual(["duration", "resolution", "fps", "silence", "light", "one_face", "face_clear"]);
    expect(result.tips).toContain(
      "Face a window in daylight, or put one soft light in front of you. No bright light behind you.",
    );
    expect(result.tips).toContain("Only you should be in the clip. Nobody else, and no photos or screens with faces.");
  });
});
