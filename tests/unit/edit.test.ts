import { describe, expect, it } from "vitest";
import { CAPTION_LAYOUT, CAPTION_STYLES, CAPTION_STYLE_NAMES, estimatePageBox, type CaptionBox } from "@/lib/captions";
import {
  EDIT_OUTPUT,
  EDIT_OVERLAYS,
  buildEditArgs,
  buildLoudnessMeasureArgs,
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

const base = {
  input: "/tmp/job/raw.mp4",
  output: "/tmp/job/final.mp4",
  captionsPath: "/tmp/job/captions.ass",
  fontsDir: "/app/assets/fonts",
};

describe("buildEditArgs", () => {

  it("returns the exact argv (never a shell string); always +faststart (p4-b2)", () => {
    expect(buildEditArgs(base)).toEqual([
      "-nostdin", "-hide_banner", "-nostats", "-loglevel", "info", "-y",
      "-i", "/tmp/job/raw.mp4",
      "-filter_complex",
      `${videoFilterGraph("/tmp/job/captions.ass", "/app/assets/fonts")};[0:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[aout]`,
      "-map", "[vout]", "-map", "[aout]", // the voice track is required: no sound = an error, not a silent reel
      "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
      "-movflags", "+faststart",
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

  it("refuses relative b-roll / music paths and music without the video length", () => {
    expect(() => buildEditArgs({ ...base, durationS: 6, extras: { broll: [{ path: "b.mp4", start_s: 2, duration_s: 2 }] } })).toThrow("absolute");
    expect(() => buildEditArgs({ ...base, durationS: 6, extras: { music: { path: "m.m4a" } } })).toThrow("absolute");
    expect(() => buildEditArgs({ ...base, extras: { music: { path: "/tmp/m.m4a" } } })).toThrow("length");
  });
});

// ---------------------------------------------------------------------------
// p4-b2: b-roll, music + loudness, AI label, trial watermark, +faststart
// ---------------------------------------------------------------------------

const FONTS = "/app/assets/fonts";
const SCALE = "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30";
const SUBS = "subtitles=filename=/tmp/job/captions.ass:fontsdir=/app/assets/fonts";
const LABEL =
  "drawtext=fontfile=/app/assets/fonts/Poppins-SemiBold.ttf:text=AI-generated:expansion=none:fontsize=34:fontcolor=white" +
  ":box=1:boxcolor=black@0.55:boxborderw=12:x=152:y=262";
// p4-b3: the corner tag sits on a semi-opaque dark box (legible on light b-roll), like the label.
const WATERMARK_TAG =
  "drawtext=fontfile=/app/assets/fonts/Poppins-Bold.ttf:text=TRIAL PREVIEW:expansion=none:fontsize=34:fontcolor=white" +
  ":box=1:boxcolor=black@0.5:boxborderw=12:x=w-tw-152:y=262";
// p4-b3: plus a big, faint (35%) "TRIAL PREVIEW", horizontally centred; p5-a3: 82 px, centred on
// y 1189, the band between the face zone (1150) and the highest 2-line caption box (≈1228).
const WATERMARK_CENTRE =
  "drawtext=fontfile=/app/assets/fonts/Poppins-Bold.ttf:text=TRIAL PREVIEW:expansion=none:fontsize=82:fontcolor=white@0.35" +
  ":borderw=2:bordercolor=black@0.2:x=(w-tw)/2:y=1189-th/2";
const WATERMARK = `${WATERMARK_CENTRE},${WATERMARK_TAG}`;
const MEASURED = { input_i: -19.43, input_tp: -6.02, input_lra: 3.1, input_thresh: -29.61, target_offset: 0.05 };
const FMT = "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo";

describe("videoFilterGraph: b-roll, label, watermark (p4-b2)", () => {
  it("b-roll: each clip scaled/cropped to 1080x1920 30 fps, trimmed, shifted to its start, overlaid only in its window; captions on top", () => {
    const g = videoFilterGraph("/tmp/job/captions.ass", FONTS, {
      broll: [
        { input: 1, start_s: 2.72, duration_s: 1.5 },
        { input: 2, start_s: 8, duration_s: 2.5 },
      ],
    });
    expect(g).toBe(
      [
        `[0:v]${SCALE}[base]`,
        `[1:v]${SCALE},trim=duration=1.5,setpts=PTS-STARTPTS+2.72/TB[b1]`,
        `[base][b1]overlay=enable='between(t,2.72,4.22)':eof_action=pass[v1]`,
        `[2:v]${SCALE},trim=duration=2.5,setpts=PTS-STARTPTS+8/TB[b2]`,
        `[v1][b2]overlay=enable='between(t,8,10.5)':eof_action=pass[v2]`,
        `[v2]${SUBS}[vout]`,
      ].join(";"),
    );
  });

  it("AI label: drawn after the captions when on, absent when off", () => {
    expect(videoFilterGraph("/tmp/job/captions.ass", FONTS, { aiLabel: true })).toBe(`[0:v]${SCALE},${SUBS},${LABEL}[vout]`);
    expect(videoFilterGraph("/tmp/job/captions.ass", FONTS, { aiLabel: false })).not.toContain("AI-generated");
  });

  it("trial watermark: only when asked; label first, then watermark", () => {
    expect(videoFilterGraph("/tmp/job/captions.ass", FONTS, { aiLabel: true, watermark: true })).toBe(
      `[0:v]${SCALE},${SUBS},${LABEL},${WATERMARK}[vout]`,
    );
    expect(videoFilterGraph("/tmp/job/captions.ass", FONTS, { aiLabel: true })).not.toContain("TRIAL PREVIEW");
  });

  it("escapes an awkward fonts folder inside drawtext too", () => {
    expect(videoFilterGraph("/tmp/c.ass", "/f;o:nts", { aiLabel: true })).toContain("drawtext=fontfile=/f\\;o\\\\:nts/Poppins-SemiBold.ttf:");
  });

  it("p4-b3: a semi-opaque dark box (box=1, black@~0.5, padding) behind the AI label AND the corner trial tag", () => {
    const g = videoFilterGraph("/tmp/job/captions.ass", FONTS, { aiLabel: true, watermark: true });
    const drawtexts = g.split(/,(?=drawtext=)/).slice(1).map((f) => f.replace(/\[vout\]$/, ""));
    const label = drawtexts.find((f) => f.includes("text=AI-generated"))!;
    const tag = drawtexts.find((f) => f.includes("text=TRIAL PREVIEW") && f.includes("x=w-tw-"))!;
    for (const f of [label, tag]) {
      expect(f).toContain(":box=1:");
      const alpha = Number(f.match(/:boxcolor=black@([\d.]+):/)?.[1]);
      expect(alpha).toBeGreaterThanOrEqual(0.4);
      expect(alpha).toBeLessThanOrEqual(0.6);
      expect(Number(f.match(/:boxborderw=(\d+):/)?.[1])).toBeGreaterThanOrEqual(8);
    }
  });

  // p5-a3 (Rowan, overrides the p4-b3 "middle third, ~70% width"): the big faint centre mark moves
  // into the lower-middle band, clear of the face (CAPTION_LAYOUT.face_zone) AND the caption box of
  // every style at its tallest (2 lines), with at least 4 px to spare on both sides.
  it("p5-a3: the centre trial mark's SAFE box clears the face and every caption style (2 lines), inside the frame and side margins", () => {
    const c = EDIT_OVERLAYS.watermark_centre;
    const W = CAPTION_LAYOUT.width;
    const H = CAPTION_LAYOUT.height;
    expect(c.colour).toBe("white@0.35"); // still faint
    const centre = videoFilterGraph("/tmp/job/captions.ass", FONTS, { watermark: true })
      .split(/,(?=drawtext=)/)
      .find((f) => f.includes(":x=(w-tw)/2:"))!;
    expect(centre).toContain(`:fontsize=${c.size}:`);
    // drawtext's y as written in the REAL filter, worked out for a text height th (h = frame height).
    const yExpr = centre.match(/:y=([^:,[]+)/)![1];
    const yAt = (th: number) => {
      const arithmetic = yExpr.replace(/\bth\b/g, `(${th})`).replace(/\bh\b/g, `(${H})`);
      expect(arithmetic).toMatch(/^[\d.+\-*/() ]+$/);
      return Number(new Function(`return (${arithmetic});`)());
    };
    // Safe box: the MEASURED width bound (width_em max) and the height bound (height_em, incl. the border).
    const safeW = c.width_em[1] * c.size;
    const safeH = c.height_em * c.size;
    // The y must centre the text on one line whatever its real height, so the real drawn box
    // (th ≤ safeH, checked with real ffmpeg in tests/integration/edit-extras-ffmpeg.test.ts) sits inside this one.
    expect(yAt(0) - yAt(safeH)).toBeCloseTo(safeH / 2, 6);
    const mark = { left: (W - safeW) / 2, right: (W + safeW) / 2, top: yAt(safeH), bottom: yAt(safeH) + safeH };
    const overlaps = (a: CaptionBox, b: CaptionBox) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

    // Inside the frame and the 140 px side margins.
    expect(mark.left).toBeGreaterThanOrEqual(CAPTION_LAYOUT.safe.left);
    expect(mark.right).toBeLessThanOrEqual(W - CAPTION_LAYOUT.safe.right);
    expect(mark.top).toBeGreaterThanOrEqual(0);
    expect(mark.bottom).toBeLessThanOrEqual(H);
    // Clear of the face box (full width, y 300-1150), with ≥ 4 px.
    const face: CaptionBox = { left: 0, right: W, top: CAPTION_LAYOUT.face_zone.top, bottom: CAPTION_LAYOUT.face_zone.bottom };
    expect(overlaps(mark, face)).toBe(false);
    expect(mark.top).toBeGreaterThanOrEqual(face.bottom + 4);
    // Clear of each style's caption box at its tallest: 2 full lines at full size, ≥ 4 px.
    for (const name of CAPTION_STYLE_NAMES) {
      const style = CAPTION_STYLES[name];
      const line = () => [{ text: "W".repeat(style.max_chars_per_line), start_s: 0, end_s: 1, source: "matched" as const, stt_indexes: [0] }];
      const caption = estimatePageBox({ lines: [line(), line()], start_s: 0, end_s: 1, scale: 1 }, name);
      expect(overlaps(mark, caption), name).toBe(false);
      expect(mark.bottom, name).toBeLessThanOrEqual(caption.top - 4);
    }
    // Still a big mark (Rowan expects about 55-60% of the width).
    expect(c.width_em[0] * c.size).toBeGreaterThanOrEqual(0.5 * W);
  });

  it("label and watermark sit inside the safe zone, above the caption band, and never overlap", () => {
    const { label, watermark } = EDIT_OVERLAYS;
    const box = (o: { x: number; y: number; size: number; pad: number; chars: number }, rightAligned = false) => {
      const w = o.chars * o.size * 0.62 + 2 * o.pad; // generous width estimate
      const left = rightAligned ? CAPTION_LAYOUT.width - CAPTION_LAYOUT.safe.right - w : o.x - o.pad;
      return { left, right: left + w, top: o.y - o.pad, bottom: o.y + o.size * 1.25 + o.pad };
    };
    const l = box(label);
    const w = box(watermark, true);
    for (const b of [l, w]) {
      expect(b.left).toBeGreaterThanOrEqual(CAPTION_LAYOUT.safe.left);
      expect(b.right).toBeLessThanOrEqual(CAPTION_LAYOUT.width - CAPTION_LAYOUT.safe.right);
      expect(b.top).toBeGreaterThanOrEqual(CAPTION_LAYOUT.safe.top);
      expect(b.bottom).toBeLessThan(CAPTION_LAYOUT.face_zone.bottom); // captions start below the face zone
    }
    expect(l.right).toBeLessThan(w.left);
  });
});

describe("buildEditArgs with every extra (p4-b2)", () => {
  const full = {
    ...base,
    durationS: 12,
    extras: {
      broll: [
        { path: "/tmp/job/b1.mp4", start_s: 2.72, duration_s: 1.5 },
        { path: "/tmp/job/b2.mp4", start_s: 8, duration_s: 2.5 },
      ],
      music: { path: "/tmp/job/bed.m4a" },
      loudness: MEASURED,
      ai_label: true,
      watermark: true,
      faststart: true,
    },
  };

  it("inputs: raw (0), b-roll clips (1..n), then the music bed looped (-stream_loop -1); one filter_complex; [vout] + [aout]", () => {
    const args = buildEditArgs(full);
    expect(args.slice(0, 17)).toEqual([
      "-nostdin", "-hide_banner", "-nostats", "-loglevel", "info", "-y",
      "-i", "/tmp/job/raw.mp4",
      "-i", "/tmp/job/b1.mp4",
      "-i", "/tmp/job/b2.mp4",
      "-stream_loop", "-1", "-i", "/tmp/job/bed.m4a",
      "-filter_complex",
    ]);
    const graph = args[17];
    expect(graph.startsWith(`[0:v]${SCALE}[base];[1:v]`)).toBe(true);
    expect(graph).toContain(`${SUBS},${LABEL},${WATERMARK}[vout]`);
    expect(graph).toContain(`[3:a]${FMT},atrim=duration=12,afade=t=in:d=0.5,afade=t=out:st=10.5:d=1.5,volume=-22dB[bed]`);
    expect(graph).toContain("[bed][sc]sidechaincompress=threshold=0.02:ratio=8:attack=20:release=400[music]");
    expect(graph).toContain(
      "amix=inputs=2:duration=first:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=-19.43:measured_TP=-6.02" +
        ":measured_LRA=3.1:measured_thresh=-29.61:offset=0.05:linear=true:print_format=summary,aresample=48000[aout]",
    );
    expect(args.slice(18)).toEqual([
      "-map", "[vout]", "-map", "[aout]",
      "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
      "-movflags", "+faststart",
      "/tmp/job/final.mp4",
    ]);
  });

  it("loudness pass 1: the same audio chain into loudnorm print_format=json, nothing written (-f null)", () => {
    expect(buildLoudnessMeasureArgs({ input: "/tmp/job/raw.mp4", musicPath: "/tmp/job/bed.m4a", durationS: 12 })).toEqual([
      "-nostdin", "-hide_banner", "-nostats", "-loglevel", "info",
      "-i", "/tmp/job/raw.mp4",
      "-stream_loop", "-1", "-i", "/tmp/job/bed.m4a",
      "-filter_complex",
      `[0:a]${FMT},asplit=2[voice][sc];` +
        `[1:a]${FMT},atrim=duration=12,afade=t=in:d=0.5,afade=t=out:st=10.5:d=1.5,volume=-22dB[bed];` +
        "[bed][sc]sidechaincompress=threshold=0.02:ratio=8:attack=20:release=400[music];" +
        "[voice][music]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json[aout]",
      "-map", "[aout]", "-f", "null", "-",
    ]);
    expect(buildLoudnessMeasureArgs({ input: "/tmp/job/raw.mp4", musicPath: null, durationS: 12 })).toContain(
      `[0:a]${FMT},loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json[aout]`,
    );
  });

  it("publish guard input: every requested extra is found in the real argv → nothing missing", () => {
    expect(notYetApplied(full.extras, buildEditArgs(full))).toEqual([]);
    expect(notYetApplied(undefined, buildEditArgs(base))).toEqual([]);
  });

  it("publish guard: an extra missing from the argv is named (label, watermark, b-roll, music, loudness, faststart)", () => {
    const args = buildEditArgs(full);
    const without = (from: string, to = "") => args.map((a) => a.replace(from, to));
    expect(notYetApplied(full.extras, without(`,${LABEL}`))).toEqual(["ai_label"]);
    expect(notYetApplied(full.extras, without(`,${WATERMARK}`))).toEqual(["watermark"]);
    // p4-b3: both trial marks are needed: the big centre one alone or the corner tag alone is not enough.
    expect(notYetApplied(full.extras, without(`,${WATERMARK_CENTRE}`))).toEqual(["watermark"]);
    expect(notYetApplied(full.extras, without(`,${WATERMARK_TAG}`))).toEqual(["watermark"]);
    expect(notYetApplied(full.extras, without("[base][b1]overlay=", "[base][b1]xoverlay="))).toEqual(["broll"]);
    expect(notYetApplied(full.extras, without("sidechaincompress", "acompressor"))).toEqual(["music"]);
    expect(notYetApplied(full.extras, without(":linear=true"))).toEqual(["loudness"]);
    expect(notYetApplied(full.extras, args.filter((a) => a !== "-movflags" && a !== "+faststart"))).toEqual(["faststart"]);
    // Asked for, argv built WITHOUT them (e.g. an old builder): all named.
    expect(notYetApplied(full.extras, buildEditArgs(base))).toEqual(["broll", "music", "loudness", "ai_label", "watermark"]);
  });

  it("nothing asked → nothing missing", () => {
    expect(notYetApplied({ broll: [], music: null, loudness: null, ai_label: false, watermark: false }, buildEditArgs(base))).toEqual([]);
  });
});
