import { describe, expect, it } from "vitest";
import { alignWords, groupPages } from "@/lib/captions";
import type { EditManifest } from "@/lib/qa/edit-manifest";
import {
  firstOfMoovMdat,
  parseBlackdetect,
  parseEbur128,
  parseFinalProbe,
  parseFreezedetect,
  technicalIssues,
  type TechnicalInput,
} from "@/lib/qa/technical-checks";
import { transcriptFor } from "@/tests/helpers/edit-real";

// Gate 4 pure checks (QA-SPEC "Gate 4: Technical QA"): the ffprobe / ffmpeg output parsers and one
// rule per check. Literal outputs below were captured from ffmpeg 7.1 runs.

const PROBE = JSON.stringify({
  streams: [
    { codec_type: "video", codec_name: "h264", width: 1080, height: 1920, pix_fmt: "yuv420p", avg_frame_rate: "30/1", r_frame_rate: "30/1" },
    { codec_type: "audio", codec_name: "aac", sample_rate: "48000", channels: 2 },
  ],
  format: { duration: "6.000000", size: "2400000" },
});
const EBUR128 = `[Parsed_ebur128_3 @ 0x7f707c0067c0] t: 4.999979   TARGET:-23 LUFS    M:   nan S: -19.1     I: -16.3 LUFS       LRA:   3.0 LU  FTPK:  -inf dBFS  TPK: -10.5 dBFS
[Parsed_ebur128_3 @ 0x7f707c0067c0] Summary:

  Integrated loudness:
    I:         -14.2 LUFS
    Threshold: -24.5 LUFS

  Loudness range:
    LRA:         3.0 LU

  True peak:
    Peak:       -1.6 dBFS`;
const BLACK = `[blackdetect @ 0x7f707c006400] black_start:0 black_end:1 black_duration:1
[blackdetect @ 0x7f707c006400] black_start:2.5 black_end:2.7 black_duration:0.2`;
const FREEZE = `[freezedetect @ 0x7f707c003780] lavfi.freezedetect.freeze_start: 0
[freezedetect @ 0x7f707c003780] lavfi.freezedetect.freeze_duration: 1
[freezedetect @ 0x7f707c003780] lavfi.freezedetect.freeze_end: 1
[freezedetect @ 0x7f707c003780] lavfi.freezedetect.freeze_start: 3`;

describe("parsers", () => {
  it("ffprobe: size, length, codecs, pixel format, frame rate, sample rate", () => {
    expect(parseFinalProbe(PROBE)).toEqual({
      width: 1080, height: 1920, fps: 30, videoCodec: "h264", pixFmt: "yuv420p", audioCodec: "aac", sampleRate: 48000, durationS: 6, sizeBytes: 2400000,
    });
  });

  it("ebur128: the Summary's integrated loudness and true peak (never the per-frame lines)", () => {
    expect(parseEbur128(EBUR128)).toEqual({ i: -14.2, tp: -1.6 });
    expect(parseEbur128("no summary here I: -16.3 LUFS")).toBeNull();
    expect(parseEbur128("Summary:\n I: -inf LUFS\n True peak:\n Peak: -inf dBFS")).toEqual({ i: -Infinity, tp: -Infinity });
  });

  it("blackdetect and freezedetect: every range; a freeze still running at the end lasts until the end", () => {
    expect(parseBlackdetect(BLACK)).toEqual([
      { start_s: 0, end_s: 1 },
      { start_s: 2.5, end_s: 2.7 },
    ]);
    expect(parseFreezedetect(FREEZE, 5)).toEqual([
      { start_s: 0, end_s: 1 },
      { start_s: 3, end_s: 5 },
    ]);
    expect(parseBlackdetect("")).toEqual([]);
  });

  it("+faststart: which top-level box comes first, moov or mdat (32- and 64-bit sizes)", () => {
    const box = (type: string, size: number) => {
      const b = Buffer.alloc(8);
      b.writeUInt32BE(size);
      b.write(type, 4, "ascii");
      return Buffer.concat([b, Buffer.alloc(size - 8)]);
    };
    const reader = (bytes: Buffer) => (offset: number, length: number) => (offset >= bytes.length ? null : bytes.subarray(offset, offset + length));
    expect(firstOfMoovMdat(reader(Buffer.concat([box("ftyp", 24), box("moov", 16), box("mdat", 16)])))).toBe("moov");
    expect(firstOfMoovMdat(reader(Buffer.concat([box("ftyp", 24), box("free", 8), box("mdat", 16), box("moov", 16)])))).toBe("mdat");
    const big = Buffer.alloc(16);
    big.writeUInt32BE(1);
    big.write("mdat", 4, "ascii");
    big.writeBigUInt64BE(BigInt(32), 8);
    expect(firstOfMoovMdat(reader(Buffer.concat([box("ftyp", 24), big, Buffer.alloc(16), box("moov", 16)])))).toBe("mdat");
    expect(firstOfMoovMdat(reader(Buffer.from("not an mp4 at all")))).toBeNull();
  });
});

// A good 6 s talking reel: the editor's own pages for a real-looking transcript.
const DISPLAY = "Stop scrolling! Grow your WhatsApp sales today. Book a free call now.";
const TRANSCRIPT = transcriptFor("stop scrolling grow your whatsapp sales today book a free call now", 6);
const goodManifest = (): EditManifest => ({
  version: 1, raw_duration_s: 6, format: "talking", caption_style: "big_words", avoid_clips: [],
  captions: groupPages(alignWords(DISPLAY, TRANSCRIPT), "big_words"),
  broll: [{ start_s: 2, duration_s: 1.5, clip: "cafe-green" }],
  protected: { hook_end_s: 1.5, cta_start_s: 4 },
  music: { bed_id: "bed-calm", gain_db: -22 },
  ai_label: true, watermark: false, not_applied: [],
});
const good = (): TechnicalInput => ({
  probe: parseFinalProbe(PROBE),
  boxFirst: "moov",
  loudness: { i: -14.2, tp: -1.6 },
  black: [],
  freeze: [],
  stems: { voice: -14, music: -36 },
  manifest: goodManifest(),
  transcript: TRANSCRIPT,
  displayText: DISPLAY,
  names: ["WhatsApp"],
  aiLabel: true,
  watermark: false,
  maxSeconds: 60,
});
const codes = (input: TechnicalInput) => technicalIssues(input).map((i) => i.code);

describe("technicalIssues: one rule per QA-SPEC Gate 4 check", () => {
  it("a good reel has no issues", () => {
    expect(technicalIssues(good())).toEqual([]);
  });

  it("format: 1080x1920, 30 fps, H.264 yuv420p, AAC 48 kHz, moov before mdat", () => {
    for (const probe of [{ fps: 25 }, { width: 720 }, { pixFmt: "yuv444p" }, { videoCodec: "hevc" }, { audioCodec: "mp3" }, { sampleRate: 44100 }]) {
      expect(codes({ ...good(), probe: { ...good().probe, ...probe } })).toEqual(["format"]);
    }
    expect(codes({ ...good(), boxFirst: "mdat" })).toEqual(["faststart"]);
  });

  it("duration ≤ plan max + 1 s; file size under 100 MB per 60 s", () => {
    expect(codes({ ...good(), probe: { ...good().probe, durationS: 61 } })).toEqual([]);
    expect(codes({ ...good(), probe: { ...good().probe, durationS: 61.2 } })).toEqual(["duration_max"]);
    expect(codes({ ...good(), probe: { ...good().probe, sizeBytes: 11_000_000 } })).toEqual(["file_size"]);
  });

  it("loudness -14 ±1.5 LUFS, true peak ≤ -1 dBTP; music stem ≥ 15 dB under the voice", () => {
    expect(codes({ ...good(), loudness: { i: -15.4, tp: -1.2 } })).toEqual([]);
    expect(codes({ ...good(), loudness: { i: -16, tp: -1.2 } })).toEqual(["loudness"]);
    expect(codes({ ...good(), loudness: { i: -14, tp: -0.5 } })).toEqual(["true_peak"]);
    expect(codes({ ...good(), loudness: null })).toEqual(["loudness"]);
    expect(codes({ ...good(), stems: { voice: -20, music: -33 } })).toEqual(["music_level"]);
    expect(codes({ ...good(), stems: null })).toEqual(["music_level"]); // music was used but not measured
    expect(codes({ ...good(), stems: null, manifest: { ...goodManifest(), music: null } })).toEqual([]);
  });

  it("black frames > 0.5 s and frozen frames > 1.5 s fail, with the time they start", () => {
    expect(codes({ ...good(), black: [{ start_s: 0, end_s: 0.4 }] })).toEqual([]);
    expect(technicalIssues({ ...good(), black: [{ start_s: 0.2, end_s: 0.9 }] })).toEqual([expect.objectContaining({ code: "black_frames", at_seconds: 0.2 })]);
    expect(codes({ ...good(), freeze: [{ start_s: 1, end_s: 2.4 }] })).toEqual([]);
    expect(technicalIssues({ ...good(), freeze: [{ start_s: 1, end_s: 3 }] })).toEqual([expect.objectContaining({ code: "frozen_frames", at_seconds: 1 })]);
  });

  it("caption timing: each heard caption word within 150 ms of its speech-to-text time", () => {
    const shifted = (by: number) => {
      const m = goodManifest();
      m.captions[0].lines[0][0].start_s += by;
      return m;
    };
    expect(codes({ ...good(), manifest: shifted(0.1) })).toEqual([]);
    expect(technicalIssues({ ...good(), manifest: shifted(0.2) })).toEqual([
      expect.objectContaining({ code: "caption_timing", detail: expect.stringContaining('"Stop"') }),
    ]);
  });

  it("caption text matches display_text, and brand names are spelled right", () => {
    const m = goodManifest();
    const word = m.captions.flatMap((p) => p.lines.flat()).find((w) => w.text === "WhatsApp")!;
    word.text = "WhatApp";
    expect(codes({ ...good(), manifest: m })).toEqual(["caption_text", "caption_brand_name"]);
  });

  it("caption layout: at most 2 lines, inside the safe zone", () => {
    const three = goodManifest();
    const page = three.captions[0];
    page.lines = [...page.lines, ...page.lines, ...page.lines].slice(0, 3);
    expect(codes({ ...good(), manifest: three })).toContain("caption_lines");
    const huge = goodManifest();
    huge.captions[0].scale = 3;
    expect(codes({ ...good(), manifest: huge })).toEqual(["caption_safe_zone"]);
  });

  it("b-roll: 1.5 to 3 s cuts, coverage within the format limit, face on the hook and the CTA", () => {
    const cuts = (broll: EditManifest["broll"], format: "talking" | "story" = "talking") => ({ ...good(), manifest: { ...goodManifest(), broll, format } });
    expect(codes(cuts([{ start_s: 2, duration_s: 1.2, clip: "a" }]))).toEqual(["broll_cut_length"]);
    expect(codes(cuts([{ start_s: 2, duration_s: 3.5, clip: "a" }]))).toEqual(["broll_cut_length", "broll_coverage", "broll_over_face"]);
    expect(codes(cuts([{ start_s: 1.6, duration_s: 2.0, clip: "a" }]))).toEqual(["broll_coverage"]);
    expect(codes(cuts([{ start_s: 1.6, duration_s: 2.0, clip: "a" }], "story"))).toEqual([]);
    expect(codes(cuts([{ start_s: 1, duration_s: 1.5, clip: "a" }]))).toEqual(["broll_over_face"]);
    expect(codes(cuts([{ start_s: 3.5, duration_s: 1.5, clip: "a" }]))).toEqual(["broll_over_face"]);
  });

  it("labels: the AI label when ai_label is on; the watermark only (and always) on trial videos", () => {
    expect(codes({ ...good(), manifest: { ...goodManifest(), ai_label: false } })).toEqual(["ai_label_missing"]);
    expect(codes({ ...good(), manifest: { ...goodManifest(), not_applied: ["ai_label"] } })).toEqual(["ai_label_missing"]);
    expect(codes({ ...good(), aiLabel: false, manifest: { ...goodManifest(), ai_label: false } })).toEqual([]);
    expect(codes({ ...good(), watermark: true })).toEqual(["watermark_missing"]);
    expect(codes({ ...good(), manifest: { ...goodManifest(), watermark: true } })).toEqual(["watermark_not_trial"]);
    expect(codes({ ...good(), watermark: true, manifest: { ...goodManifest(), watermark: true } })).toEqual([]);
  });
});
