import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  convertToMp4Args,
  brightnessArgs,
  frameArgs,
  frameTimes,
  loudnessArgs,
  measureClip,
  parseBrightness,
  parseLoudness,
  parseProbe,
  parseSilences,
  probeArgs,
  sampleFrames,
  silenceArgs,
} from "@/lib/clip-checks/media";

const hasFfmpeg =
  spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;
const GOOD = path.resolve("tests/fixtures/consent-good.mp4");
const BAD = path.resolve("tests/fixtures/consent-bad.mp4");

describe("command builder (no shell: every value is its own argument)", () => {
  const tricky = "/tmp/my clip; rm -rf ~ $(whoami).mp4";

  it("ffprobe reads streams and format as JSON", () => {
    expect(probeArgs(tricky)).toEqual([
      "-v", "error", "-print_format", "json", "-show_format", "-show_streams", tricky,
    ]);
  });

  it("ffmpeg passes measure loudness, silences and brightness", () => {
    const base = ["-nostdin", "-hide_banner", "-nostats", "-i", tricky];
    expect(loudnessArgs(tricky)).toEqual([...base, "-vn", "-af", "ebur128=peak=none", "-f", "null", "-"]);
    expect(silenceArgs(tricky, -40, 0.5)).toEqual([...base, "-vn", "-af", "silencedetect=noise=-40dB:d=0.5", "-f", "null", "-"]);
    expect(brightnessArgs(tricky)).toEqual([
      ...base, "-an", "-vf", "fps=2,signalstats,metadata=mode=print:key=lavfi.signalstats.YAVG", "-f", "null", "-",
    ]);
  });

  it("one frame as JPEG on stdout, seeking before the input", () => {
    expect(frameArgs(tricky, 2.5)).toEqual([
      "-nostdin", "-hide_banner", "-loglevel", "error", "-ss", "2.500", "-i", tricky,
      "-frames:v", "1", "-vf", "scale=-2:768", "-f", "image2pipe", "-c:v", "mjpeg", "pipe:1",
    ]);
  });

  it("refuses a path that ffmpeg could read as an option", () => {
    expect(() => probeArgs("-i")).toThrow("Clip path must be an absolute file path.");
    expect(() => loudnessArgs("relative/clip.mp4")).toThrow("Clip path must be an absolute file path.");
  });

  it("6 frame times spread over the clip, away from the very start and end", () => {
    expect(frameTimes(12, 6)).toEqual([1, 3, 5, 7, 9, 11]);
    expect(frameTimes(0, 6)).toEqual([0, 0, 0, 0, 0, 0]);
  });
});

describe("parsers", () => {
  it("ffprobe JSON → duration, size, fps, audio", () => {
    const json = JSON.stringify({
      streams: [
        { codec_type: "video", width: 1080, height: 1920, avg_frame_rate: "30000/1001", tags: {} },
        { codec_type: "audio" },
      ],
      format: { duration: "120.5" },
    });
    expect(parseProbe(json)).toEqual({ durationS: 120.5, width: 1080, height: 1920, fps: 29.97, hasAudio: true });
  });

  it("a phone clip filmed upright reports a rotation; width and height are swapped back", () => {
    const json = JSON.stringify({
      streams: [{ codec_type: "video", width: 1920, height: 1080, avg_frame_rate: "30/1", side_data_list: [{ rotation: -90 }] }],
      format: { duration: "10" },
    });
    expect(parseProbe(json)).toMatchObject({ width: 1080, height: 1920, hasAudio: false });
  });

  it("ebur128 summary → integrated loudness", () => {
    const stderr = `[Parsed_ebur128_0 @ 0x1] Summary:\n\n  Integrated loudness:\n    I:         -18.4 LUFS\n    Threshold: -28.6 LUFS\n`;
    expect(parseLoudness(stderr)).toBe(-18.4);
    expect(parseLoudness("    I:         -inf LUFS\n")).toBe(-Infinity);
    expect(parseLoudness("nothing")).toBeNull();
  });

  it("silencedetect → longest silence, counting one that runs to the end", () => {
    const stderr = [
      "[silencedetect @ 0x1] silence_start: 1.2",
      "[silencedetect @ 0x1] silence_end: 2.0 | silence_duration: 0.8",
      "[silencedetect @ 0x1] silence_start: 9",
    ].join("\n");
    expect(parseSilences(stderr, 12)).toBe(3);
    expect(parseSilences("", 12)).toBe(0);
  });

  it("signalstats → average brightness (0 to 255)", () => {
    const stdout = "lavfi.signalstats.YAVG=100.5\nframe:1\nlavfi.signalstats.YAVG=99.5\n";
    expect(parseBrightness(stdout)).toBe(100);
    expect(parseBrightness("")).toBeNull();
  });
});

describe.skipIf(!hasFfmpeg)("real ffprobe and ffmpeg on the fixtures", () => {
  it("good clip: 16 s, 1080x1920, 30 fps, loud enough, no long silence, bright", async () => {
    const m = await measureClip(GOOD);
    expect(m.durationS).toBeCloseTo(16, 0);
    expect([m.width, m.height, Math.round(m.fps)]).toEqual([1080, 1920, 30]);
    expect(m.hasAudio).toBe(true);
    expect(m.loudnessLufs).toBeGreaterThan(-25);
    expect(m.longestSilenceS).toBeLessThan(1);
    expect(m.brightness).toBeGreaterThan(120);
  });

  it("bad clip: 8 s, 720x1280, 24 fps, a 5 s silence, dark", async () => {
    const m = await measureClip(BAD);
    expect(m.durationS).toBeCloseTo(8, 0);
    expect([m.width, m.height, Math.round(m.fps)]).toEqual([720, 1280, 24]);
    expect(m.longestSilenceS).toBeGreaterThan(4);
    expect(m.brightness).toBeLessThan(40);
  });

  it("samples 6 JPEG frames", async () => {
    const frames = await sampleFrames(GOOD, 16, 6);
    expect(frames).toHaveLength(6);
    for (const frame of frames) expect([...frame.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
  });
});

describe("decision 5: .mov → mp4 conversion command (no shell, each value its own argument)", () => {
  it("re-encodes to H.264 + AAC with faststart into our temp output", () => {
    expect(convertToMp4Args("/tmp/in.mov", "/tmp/out.mp4")).toEqual([
      "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
      "-i", "/tmp/in.mov",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart",
      "/tmp/out.mp4",
    ]);
  });

  it("refuses relative paths (so a name can never look like an option)", () => {
    expect(() => convertToMp4Args("-i.mov", "/tmp/out.mp4")).toThrow("Clip path must be an absolute file path.");
    expect(() => convertToMp4Args("/tmp/in.mov", "out.mp4")).toThrow("Clip path must be an absolute file path.");
  });
});
