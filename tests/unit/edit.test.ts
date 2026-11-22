import { describe, expect, it } from "vitest";
import {
  EDIT_OUTPUT,
  buildEditArgs,
  escapeFilterGraph,
  escapeFilterOption,
  escapeFilterValue,
  notYetApplied,
  videoFilterGraph,
} from "@/lib/edit";

// lib/edit.ts: the ffmpeg argv for one edit, as explicit strings (no snapshots).
// Escaping follows ffmpeg-filters "Notes on filtergraph escaping": level 1 for
// an option value (\ ' :), level 2 for the whole graph (\ ' [ ] , ;). No shell
// is ever used (execFile), so there is no third level.

describe("filtergraph escaping", () => {
  it("matches the worked example in the ffmpeg docs", () => {
    const raw = "this is a 'string': may contain one, or more, special characters";
    expect(escapeFilterOption(raw)).toBe("this is a \\'string\\'\\: may contain one, or more, special characters");
    expect(escapeFilterGraph(`text=${escapeFilterOption(raw)}`)).toBe(
      "text=this is a \\\\\\'string\\\\\\'\\\\: may contain one\\, or more\\, special characters",
    );
  });

  it("escapes each special character in a path (both levels)", () => {
    expect(escapeFilterValue("/a:b")).toBe("/a\\\\:b");
    expect(escapeFilterValue("/a'b")).toBe("/a\\\\\\'b");
    expect(escapeFilterValue("/a\\b")).toBe("/a\\\\\\\\b");
    expect(escapeFilterValue("/a,b")).toBe("/a\\,b");
    expect(escapeFilterValue("/a[b]")).toBe("/a\\[b\\]");
    expect(escapeFilterValue("/a;b")).toBe("/a\\;b");
    expect(escapeFilterValue("/plain/path-1_2.ass")).toBe("/plain/path-1_2.ass");
  });
});

describe("videoFilterGraph", () => {
  it("covers then crops to 1080x1920, square pixels, 30 fps, then burns the captions with our fonts", () => {
    expect(videoFilterGraph("/tmp/job/captions.ass", "/app/assets/fonts")).toBe(
      "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30," +
        "subtitles=filename=/tmp/job/captions.ass:fontsdir=/app/assets/fonts[vout]",
    );
  });

  it("escapes awkward folder names", () => {
    expect(videoFilterGraph("/tmp/a:b's [x],y/captions.ass", "/f;o\\nts")).toBe(
      "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30," +
        "subtitles=filename=/tmp/a\\\\:b\\\\\\'s \\[x\\]\\,y/captions.ass:fontsdir=/f\\;o\\\\\\\\nts[vout]",
    );
  });
});

describe("buildEditArgs", () => {
  const base = {
    input: "/tmp/job/raw.mp4",
    output: "/tmp/job/final.mp4",
    captionsPath: "/tmp/job/captions.ass",
    fontsDir: "/app/assets/fonts",
  };

  it("returns the exact argv (never a shell string)", () => {
    expect(buildEditArgs(base)).toEqual([
      "-nostdin", "-hide_banner", "-nostats", "-loglevel", "info", "-y",
      "-i", "/tmp/job/raw.mp4",
      "-filter_complex", videoFilterGraph("/tmp/job/captions.ass", "/app/assets/fonts"),
      "-map", "[vout]", "-map", "0:a:0",
      "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
      "/tmp/job/final.mp4",
    ]);
  });

  it("output settings match QA-SPEC Gate 4 (1080x1920, 30 fps, H.264 yuv420p, AAC 48 kHz)", () => {
    expect(EDIT_OUTPUT).toMatchObject({ width: 1080, height: 1920, fps: 30, pix_fmt: "yuv420p", audio_rate: 48000 });
  });

  it("refuses relative paths and paths that look like options", () => {
    expect(() => buildEditArgs({ ...base, input: "raw.mp4" })).toThrow("absolute");
    expect(() => buildEditArgs({ ...base, output: "-f" })).toThrow("absolute");
    expect(() => buildEditArgs({ ...base, captionsPath: "captions.ass" })).toThrow("absolute");
    expect(() => buildEditArgs({ ...base, fontsDir: "assets/fonts" })).toThrow("absolute");
    expect(() => buildEditArgs({ ...base, output: base.input })).toThrow("must differ");
  });

  it("part B extras are typed but not applied yet, and say so", () => {
    const extras = {
      broll: [{ path: "/tmp/b.mp4", start_s: 2, duration_s: 2 }],
      music: { path: "/tmp/m.mp3", gain_db: -18 },
      ai_label: true,
      watermark: true,
      faststart: true,
    };
    expect(buildEditArgs({ ...base, extras })).toEqual(buildEditArgs(base));
    expect(notYetApplied(extras)).toEqual(["broll", "music", "ai_label", "watermark", "faststart"]);
    expect(notYetApplied({ broll: [], music: null, ai_label: false, watermark: false, faststart: false })).toEqual([]);
    expect(notYetApplied(undefined)).toEqual([]);
  });
});
