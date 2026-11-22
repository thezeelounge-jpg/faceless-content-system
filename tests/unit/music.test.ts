import { existsSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  LOUDNORM_SILENT,
  MUSIC_NOT_SET_UP,
  audioFilterGraph,
  fixtureMusicLibrary,
  getMusicLibrary,
  loudnormApplyFilter,
  loudnormMeasureFilter,
  parseLoudnormJson,
} from "@/lib/music";

// lib/music.ts: pure filter strings (checked as exact strings), the pass-1
// loudnorm parser, and the mock music set. Real ffmpeg runs are in
// tests/integration/edit-ffmpeg.test.ts.

/** What ffmpeg 7.1 prints for loudnorm print_format=json (pass 1), among other log lines. */
const PASS1_STDERR = `[aac @ 0x5581] Too many bits 8832.000000 > 6144 per frame requested
size=N/A time=00:00:06.00 bitrate=N/A speed= 120x
[Parsed_loudnorm_4 @ 0x55d0c8e3a1c0]
{
	"input_i" : "-19.43",
	"input_tp" : "-6.02",
	"input_lra" : "3.10",
	"input_thresh" : "-29.61",
	"output_i" : "-14.05",
	"output_tp" : "-1.50",
	"output_lra" : "2.80",
	"output_thresh" : "-24.20",
	"normalization_type" : "dynamic",
	"target_offset" : "0.05"
}
[out#0/null @ 0x5581] video:0KiB audio:1125KiB`;

const MEASURED = { input_i: -19.43, input_tp: -6.02, input_lra: 3.1, input_thresh: -29.61, target_offset: 0.05 };

describe("loudnorm two-pass", () => {
  it("pass 1 measures with our targets (-14 LUFS, TP -1.5, LRA 11) and prints JSON", () => {
    expect(loudnormMeasureFilter()).toBe("loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json");
  });

  it("parses the pass-1 JSON out of a noisy stderr (numbers, not strings)", () => {
    expect(parseLoudnormJson(PASS1_STDERR)).toEqual(MEASURED);
  });

  it("uses the LAST JSON block when ffmpeg printed more than one", () => {
    const twice = PASS1_STDERR.replace('"-19.43"', '"-30.00"') + "\n" + PASS1_STDERR;
    expect(parseLoudnormJson(twice).input_i).toBe(-19.43);
  });

  it("a silent voice (-inf) or missing / broken JSON is a plain error", () => {
    expect(() => parseLoudnormJson(PASS1_STDERR.replace('"-19.43"', '"-inf"'))).toThrow(LOUDNORM_SILENT);
    expect(() => parseLoudnormJson("no json here")).toThrow(/loudness/i);
    expect(() => parseLoudnormJson('{ "input_i" : "abc" }')).toThrow(/loudness/i);
  });

  it("pass 2 applies the measured values with linear=true", () => {
    expect(loudnormApplyFilter(MEASURED)).toBe(
      "loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=-19.43:measured_TP=-6.02:measured_LRA=3.1:measured_thresh=-29.61:offset=0.05:linear=true:print_format=summary",
    );
  });

  it("pass 2 keeps each measured value inside the range ffmpeg 7.1 accepts", () => {
    const f = loudnormApplyFilter({ input_i: -120, input_tp: 150, input_lra: 140, input_thresh: -130, target_offset: -150 });
    expect(f).toContain("measured_I=-99:measured_TP=99:measured_LRA=99:measured_thresh=-99:offset=-99:");
  });
});

describe("audioFilterGraph", () => {
  const F = "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo";

  it("voice only (no music): format, then loudnorm pass 2, back to 48 kHz", () => {
    expect(audioFilterGraph({ loudness: MEASURED })).toBe(`[0:a]${F},${loudnormApplyFilter(MEASURED)},aresample=48000[aout]`);
  });

  it("with music: the bed is trimmed, faded, turned down, then ducked by the voice (sidechain); voice + music mixed, then loudnorm", () => {
    expect(audioFilterGraph({ music: { input: 3, durationS: 12 }, loudness: MEASURED })).toBe(
      [
        `[0:a]${F},asplit=2[voice][sc]`,
        `[3:a]${F},atrim=duration=12,afade=t=in:d=0.5,afade=t=out:st=10.5:d=1.5,volume=-22dB[bed]`,
        "[bed][sc]sidechaincompress=threshold=0.02:ratio=8:attack=20:release=400[music]",
        `[voice][music]amix=inputs=2:duration=first:normalize=0,${loudnormApplyFilter(MEASURED)},aresample=48000[aout]`,
      ].join(";"),
    );
  });

  it("pass 1 (measure): the same chain ending in loudnorm print_format=json", () => {
    expect(audioFilterGraph({ music: { input: 1, durationS: 6 }, loudness: "measure" })).toMatch(
      /amix=inputs=2:duration=first:normalize=0,loudnorm=I=-14:TP=-1\.5:LRA=11:print_format=json\[aout\]$/,
    );
  });

  it("stems (for the Gate 4 'music 15 dB quieter' check): the same chain, one side only, the other sent to anullsink", () => {
    const voice = audioFilterGraph({ music: { input: 1, durationS: 6 }, loudness: null, stem: "voice" });
    expect(voice).toContain("[music]anullsink;[voice]anull[aout]");
    const music = audioFilterGraph({ music: { input: 1, durationS: 6 }, loudness: null, stem: "music" });
    expect(music).toContain("[voice]anullsink;[music]anull[aout]");
    expect(music).toContain("sidechaincompress=threshold=0.02:ratio=8:attack=20:release=400[music]");
  });

  it("a very short video never gets a negative fade start", () => {
    expect(audioFilterGraph({ music: { input: 1, durationS: 1 }, loudness: null })).toContain("afade=t=out:st=0:d=1.5");
  });
});

describe("music library (mock set until the real one is in Storage)", () => {
  it("picks one of the fixture beds, the same one for the same video", () => {
    const lib = getMusicLibrary();
    const a = lib.pick("90000000-0000-4000-8000-000000000001");
    expect(lib.pick("90000000-0000-4000-8000-000000000001")).toEqual(a);
    expect(["bed-calm", "bed-bright", "bed-soft"]).toContain(a.id);
    expect(path.isAbsolute(a.file) && existsSync(a.file)).toBe(true);
    const ids = new Set(Array.from({ length: 30 }, (_, i) => lib.pick(`video-${i}`).id));
    expect(ids.size).toBe(3); // every bed gets used
  });

  it("no beds in the folder → a plain 'not set up yet' error", () => {
    const empty = mkdtempSync(path.join(os.tmpdir(), "no-music-"));
    expect(() => fixtureMusicLibrary(empty).pick("x")).toThrow(MUSIC_NOT_SET_UP);
  });
});
