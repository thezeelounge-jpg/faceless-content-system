import { describe, expect, it } from "vitest";
import { CAPTION_LAYOUT, captionBoxTop, MAX_PAGE_LINES } from "@/lib/captions";
import { EDIT_OVERLAYS } from "@/lib/edit";
import { HUMAN_REVIEW, VISUAL_QA } from "@/lib/qa/config";
import type { EditManifest } from "@/lib/qa/edit-manifest";
import {
  BAND,
  captionAt,
  classifyFix,
  faceZoneIssues,
  framePlan,
  humanReviewReasons,
  HUMAN_REVIEW_TEXT,
  nextCaptionStyle,
  overlayRegions,
  overlayDrawn,
  parsePgm,
  pixelIssues,
  rubricIssues,
  sampledForReview,
  type GrayBand,
} from "@/lib/qa/visual-checks";
import { drawBand } from "@/tests/helpers/visual-frames";

// p5-b2: Gate 5's pure parts (no ffmpeg, no Claude): which frames to sample, the caption line at
// each frame, the pixel checks of the AI label and the trial tag, the face-zone check, the rubric →
// issues, the one automatic fix, and the human-review rules (QA-SPEC Gates 5 and 6).

const manifest = (over: Partial<EditManifest> = {}): EditManifest => ({
  version: 1, raw_duration_s: 7.8, format: "talking", caption_style: "big_words", avoid_clips: [],
  captions: [
    { start_s: 0.2, end_s: 1.9, scale: 1, lines: [[{ text: "Hi,", start_s: 0.2, end_s: 0.5, source: "matched", stt_indexes: [0] }], [{ text: "I'm", start_s: 0.6, end_s: 0.9, source: "matched", stt_indexes: [1] }]] },
    { start_s: 2.0, end_s: 3.0, scale: 1, lines: [[{ text: "Brush", start_s: 2.0, end_s: 2.4, source: "matched", stt_indexes: [2] }, { text: "twice", start_s: 2.5, end_s: 2.9, source: "matched", stt_indexes: [3] }]] },
  ],
  broll: [{ start_s: 2.5, duration_s: 2, clip: "clip-coffee" }],
  protected: { hook_end_s: 1.9, cta_start_s: 6 }, music: null, ai_label: true, watermark: false, not_applied: [],
  ...over,
});

describe("framePlan: QA-SPEC frames (every 2 s + first + last + one per b-roll cut)", () => {
  it("7.8 s at 30 fps with one cut at 2.5–4.5 s", () => {
    expect(framePlan({ durationS: 7.8, frameCount: 234, fps: 30, broll: [{ start_s: 2.5, duration_s: 2 }] })).toEqual([
      { n: 0, at_seconds: 0, kind: "first" },
      { n: 60, at_seconds: 2, kind: "every_2s" },
      { n: 105, at_seconds: 3.5, kind: "broll" },
      { n: 120, at_seconds: 4, kind: "every_2s" },
      { n: 180, at_seconds: 6, kind: "every_2s" },
      { n: 233, at_seconds: 7.767, kind: "last" },
    ]);
  });

  it("never twice the same frame, never past the last frame, never more than VISUAL_QA.max_frames (first, last and b-roll kept)", () => {
    const short = framePlan({ durationS: 2, frameCount: 60, fps: 30, broll: [] });
    expect(short.map((f) => f.n)).toEqual([0, 59]);
    const long = framePlan({ durationS: 120, frameCount: 3600, fps: 30, broll: [{ start_s: 10, duration_s: 2 }] });
    expect(long.length).toBe(VISUAL_QA.max_frames);
    expect(long[0].kind).toBe("first");
    expect(long.at(-1)!.kind).toBe("last");
    expect(long.some((f) => f.kind === "broll")).toBe(true);
    expect(new Set(long.map((f) => f.n)).size).toBe(long.length);
  });
});

describe("captionAt: the caption line on screen at a frame", () => {
  it("joins the page's lines; nothing between pages", () => {
    expect(captionAt(manifest(), 0.3)).toBe("Hi, / I'm");
    expect(captionAt(manifest(), 2.5)).toBe("Brush twice");
    expect(captionAt(manifest(), 1.95)).toBe("");
    expect(captionAt(manifest(), 7)).toBe("");
  });
});

describe("parsePgm (ffmpeg -f image2 .pgm, gray)", () => {
  it("reads width, height and the pixels; anything else is an error", () => {
    const bytes = new Uint8Array([...new TextEncoder().encode("P5\n3 2\n255\n"), 1, 2, 3, 4, 5, 6]);
    const band = parsePgm(bytes, 240);
    expect({ width: band.width, height: band.height, y0: band.y0, data: [...band.data] }).toEqual({ width: 3, height: 2, y0: 240, data: [1, 2, 3, 4, 5, 6] });
    expect(() => parsePgm(new TextEncoder().encode("P6\n1 1\n255\nabc"), 0)).toThrow(/not a gray/);
  });
});

describe("pixel checks of the AI label and the trial corner tag (no AI)", () => {
  it("regions come from EDIT_OVERLAYS (box above the text, text rows) and sit inside the extracted band", () => {
    const r = overlayRegions();
    const l = EDIT_OVERLAYS.label;
    expect(r.label.pad.y0).toBeGreaterThanOrEqual(l.y - l.pad);
    expect(r.label.pad.y1).toBeLessThan(l.y);
    expect(r.label.text.y0).toBe(l.y);
    expect(r.tag.text.x1).toBe(CAPTION_LAYOUT.width - EDIT_OVERLAYS.watermark.x);
    for (const reg of [r.label.pad, r.label.text, r.tag.pad, r.tag.text]) {
      expect(reg.y0).toBeGreaterThanOrEqual(BAND.y);
      expect(reg.y1).toBeLessThanOrEqual(BAND.y + BAND.height);
    }
  });

  it("a drawn box with text is seen; a plain background is not; too dark to tell → unknown", () => {
    const r = overlayRegions();
    for (const bg of [128, 187, 235]) {
      expect(overlayDrawn(drawBand({ background: bg, label: true }), r.label)).toBe("drawn");
      expect(overlayDrawn(drawBand({ background: bg, label: false }), r.label)).toBe("absent");
      expect(overlayDrawn(drawBand({ background: bg, tag: true }), r.tag)).toBe("drawn");
      expect(overlayDrawn(drawBand({ background: bg, tag: false }), r.tag)).toBe("absent");
    }
    // Bright shapes in the text rows with no darkened box above them (a busy stock clip) are NOT a drawn box.
    expect(overlayDrawn(drawBand({ background: 128, label: false, brightBits: true }), r.label)).toBe("absent");
    // Near black: a black@0.55 box can't be told apart from the background.
    expect(overlayDrawn(drawBand({ background: 20, label: true }), r.label)).toBe("unknown");
    expect(overlayDrawn(drawBand({ background: 20, label: false, brightBits: true }), r.label)).toBe("unknown");
  });

  it("frames too dark to tell never raise an issue, but a video where NO frame could be checked gets a soft note", () => {
    const dark = drawBand({ background: 20, label: true });
    const issues = pixelIssues({ frames: [{ at_seconds: 0, band: dark }], aiLabel: true, watermark: false });
    expect(issues.map((i) => [i.code, i.severity])).toEqual([["label_unverified", "soft"]]);
  });

  it("issues: label missing (ai_label on), tag missing (trial), tag present on a non-trial video; each with at_seconds", () => {
    const frames = (b: GrayBand) => [{ at_seconds: 0, band: b }, { at_seconds: 2, band: b }];
    expect(pixelIssues({ frames: frames(drawBand({ label: true })), aiLabel: true, watermark: false })).toEqual([]);
    expect(pixelIssues({ frames: frames(drawBand({ label: true, tag: true })), aiLabel: true, watermark: true })).toEqual([]);
    expect(pixelIssues({ frames: frames(drawBand({})), aiLabel: true, watermark: false }).map((i) => [i.code, i.at_seconds, i.severity])).toEqual([
      ["label_missing", 0, "hard"],
    ]);
    expect(pixelIssues({ frames: frames(drawBand({ label: true })), aiLabel: true, watermark: true }).map((i) => i.code)).toEqual(["watermark_missing"]);
    expect(pixelIssues({ frames: frames(drawBand({ label: true, tag: true })), aiLabel: true, watermark: false }).map((i) => i.code)).toEqual([
      "watermark_unexpected",
    ]);
    // ai_label off: the label is not required (and not checked).
    expect(pixelIssues({ frames: frames(drawBand({})), aiLabel: false, watermark: false })).toEqual([]);
  });
});

describe("face zone: the rubric's face box vs CAPTION_LAYOUT.face_zone (and the trial strip)", () => {
  const face = (bottom: number) => ({ top: 400, bottom, left: 300, right: 780 });
  it("inside the zone → nothing; below 1150 → face_zone_estimate (hard, team wording); trial: says it reaches the strip", () => {
    expect(faceZoneIssues({ face: face(1100), watermark: true })).toEqual([]);
    expect(faceZoneIssues({ face: null, watermark: false })).toEqual([]);
    const [low] = faceZoneIssues({ face: face(1180), watermark: false });
    expect(low).toMatchObject({ code: "face_zone_estimate", severity: "hard" });
    expect(low.detail).toMatch(/face-zone estimate.*wrong/i);
    expect(low.detail).toContain(`${CAPTION_LAYOUT.face_zone.bottom}`);
    const [trial] = faceZoneIssues({ face: face(1180), watermark: true });
    expect(trial.detail).toMatch(/TRIAL PREVIEW/);
  });
});

const good = {
  face_natural: true, mouth_area_clean: true, hands_ok: true, background_stable: true, captions_readable: true, captions_clear_of_face: true,
  broll_matches_line: true, no_stray_text: true, first_frame_strong: true, realism_score: 9,
  face_box: { top: 420, bottom: 1100, left: 300, right: 780 }, mouth_box: { top: 900, bottom: 980, left: 450, right: 630 }, issues: [],
};
const FRAMES = [
  { at_seconds: 0, kind: "first" as const },
  { at_seconds: 2, kind: "every_2s" as const },
  { at_seconds: 3.5, kind: "broll" as const },
];

describe("rubricIssues: QA-SPEC fields → issues (hard / soft), at_seconds from the frame index", () => {
  it("all good → none", () => {
    expect(rubricIssues(good, FRAMES)).toEqual([]);
  });
  it("captions over the mouth at frame 1 → captions_over_face at 2 s; soft fields stay soft; realism under 8 is hard", () => {
    const answer = {
      ...good, captions_clear_of_face: false, first_frame_strong: false, realism_score: 7,
      issues: [{ field: "captions_clear_of_face" as const, frame: 1, detail: "The caption covers the mouth." }],
    };
    expect(rubricIssues(answer, FRAMES).map((i) => [i.code, i.severity, i.at_seconds])).toEqual([
      ["captions_over_face", "hard", 2],
      ["weak_first_frame", "soft", null],
      ["realism", "hard", null],
    ]);
  });
  it("stray text on a b-roll frame is a b-roll problem; elsewhere it is not", () => {
    const at = (frame: number) => rubricIssues({ ...good, no_stray_text: false, issues: [{ field: "no_stray_text" as const, frame, detail: "Logo." }] }, FRAMES);
    expect(at(2).map((i) => i.code)).toEqual(["broll_stray_text"]);
    expect(at(0).map((i) => i.code)).toEqual(["stray_text"]);
  });
});

describe("classifyFix: ONE automatic fix per QA-SPEC (captions/b-roll → re-edit, face/realism → re-render, else the team)", () => {
  const issue = (code: string, at_seconds: number | null = null) => ({ code, detail: code, at_seconds, severity: "hard" as const });
  it("captions over the face → re-edit with the next lower caption style from VISUAL_QA.caption_fix_styles", () => {
    expect(classifyFix([issue("captions_over_face", 2)], manifest())).toMatchObject({ kind: "reedit", captionStyle: "small_box", avoidClips: [] });
  });
  it("b-roll stray text → re-edit with that clip swapped out", () => {
    expect(classifyFix([issue("broll_stray_text", 3.5)], manifest())).toMatchObject({ kind: "reedit", captionStyle: null, avoidClips: ["clip-coffee"] });
  });
  it("face or realism problems → re-render once (wins over a caption problem)", () => {
    expect(classifyFix([issue("face_glitch", 4)], manifest()).kind).toBe("rerender");
    expect(classifyFix([issue("captions_over_face", 2), issue("realism")], manifest()).kind).toBe("rerender");
  });
  it("never auto-fixed: face-zone estimate, label/watermark pixels, stray text on the face, no lower caption style left", () => {
    for (const code of ["face_zone_estimate", "label_missing", "watermark_missing", "watermark_unexpected", "stray_text", "visual_judge_failed"]) {
      expect(classifyFix([issue("captions_over_face", 2), issue(code)], manifest()).kind).toBe("team");
    }
    expect(classifyFix([issue("captions_over_face", 2)], manifest({ caption_style: "minimal" })).kind).toBe("team");
  });
  it("nextCaptionStyle: the first fix style whose 2-line box starts lower than the current one", () => {
    expect(nextCaptionStyle("big_words")).toBe("small_box");
    expect(nextCaptionStyle("small_box")).toBe("minimal");
    expect(nextCaptionStyle("minimal")).toBeNull();
    expect(captionBoxTop("small_box", MAX_PAGE_LINES)).toBeGreaterThan(captionBoxTop("big_words", MAX_PAGE_LINES));
  });
});

describe("human review (QA-SPEC Gate 6): which passed videos the team watches first", () => {
  const base = { priorPosts: 5, realism: 9, managed: false, teamReviewsEveryVideo: true, sampled: false, autoFixed: false };
  it("p5-b4 (QA-SPEC Gate 6): a video that passed only after an automatic fix (Gates 3-5) → queue, reason auto_fixed", () => {
    expect(humanReviewReasons({ ...base, autoFixed: true })).toEqual(["auto_fixed"]);
    expect(humanReviewReasons({ ...base, autoFixed: true, sampled: true })).toEqual(["auto_fixed"]);
    expect(humanReviewReasons({ ...base, autoFixed: true, priorPosts: 0 })).toEqual(["first_videos", "auto_fixed"]);
    expect(HUMAN_REVIEW_TEXT.auto_fixed).toMatch(/^Auto-fixed: /);
  });
  it("a brand's first 5 videos (0–4 earlier posts passed) → queue; the 6th → nobody", () => {
    for (let prior = 0; prior < HUMAN_REVIEW.first_videos_per_brand; prior++) {
      expect(humanReviewReasons({ ...base, priorPosts: prior })).toEqual(["first_videos"]);
    }
    expect(humanReviewReasons(base)).toEqual([]);
  });
  it("realism under 9, managed brands (until switched off), and the random 1 in 5 of the others", () => {
    expect(humanReviewReasons({ ...base, realism: 8 })).toEqual(["realism_margin"]);
    expect(humanReviewReasons({ ...base, managed: true })).toEqual(["managed"]);
    expect(humanReviewReasons({ ...base, managed: true, teamReviewsEveryVideo: false })).toEqual([]);
    expect(humanReviewReasons({ ...base, sampled: true })).toEqual(["random"]);
    // The random sample is only for videos no other rule sends.
    expect(humanReviewReasons({ ...base, realism: 8, sampled: true })).toEqual(["realism_margin"]);
  });
  it("sampledForReview: stable per video id, about 1 in 5", () => {
    const ids = Array.from({ length: 2000 }, (_, i) => `90000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    expect(ids.map(sampledForReview)).toEqual(ids.map(sampledForReview));
    const share = ids.filter(sampledForReview).length / ids.length;
    expect(share).toBeGreaterThan(0.15);
    expect(share).toBeLessThan(0.25);
  });
});
