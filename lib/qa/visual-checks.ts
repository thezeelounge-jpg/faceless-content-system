import { createHash } from "node:crypto";
import type { VisualQaOutput } from "@/lib/ai-schemas";
import { VISUAL_QA_FIELDS } from "@/lib/ai-schemas";
import { CAPTION_LAYOUT, MAX_PAGE_LINES, captionBoxTop, type CaptionStyleName } from "@/lib/captions";
import { EDIT_OVERLAYS } from "@/lib/edit";
import { HUMAN_REVIEW, VISUAL_QA } from "@/lib/qa/config";
import type { EditManifest } from "@/lib/qa/edit-manifest";
import type { QaIssue } from "@/lib/qa/script-checks";

// Gate 5 (p5-b2): the pure parts, no ffmpeg and no Claude (lib/qa/visual-gate.ts runs them).
//  - framePlan: QA-SPEC frames: one every 2 s, the first and the last, one from each b-roll cut-in.
//  - captionAt: the caption line on screen at a frame (sent to Claude with it).
//  - Pixel checks (no AI) on a gray strip across the top of each frame (BAND): the AI label and the
//    small trial tag are drawtext boxes (lib/edit.ts EDIT_OVERLAYS); "drawn" = the box rows above
//    the text are dark AND the text rows have bright letter pixels. A plain background fails one of the two.
//  - faceZoneIssues: the rubric's face box vs CAPTION_LAYOUT.face_zone (our UNCONFIRMED estimate).
//  - rubricIssues: the QA-SPEC rubric → issues (hard / soft) with at_seconds.
//  - classifyFix: QA-SPEC "On fail": caption or b-roll problem → re-edit once; face or realism
//    problem → re-render once; anything a fix can't help → the team.
//  - humanReviewReasons: QA-SPEC Gate 6, which passed videos a person watches first.

/** The strip of each frame kept for the pixel checks (full width, full resolution): it holds the label and the tag. */
export const BAND = { y: 240, height: 80 } as const;

export type GrayBand = { width: number; height: number; y0: number; data: Uint8Array };
export type FrameKind = "first" | "every_2s" | "broll" | "last";
export type PlannedFrame = { n: number; at_seconds: number; kind: FrameKind };
/** Pixel rectangle in full-frame coordinates; x1 / y1 exclusive. */
export type Region = { x0: number; x1: number; y0: number; y1: number };
/** pad = box rows above the text; text = the text rows; outside = background beside the box; alpha = the box's darkening. */
export type OverlayRegion = { pad: Region; text: Region; outside: Region; alpha: number };
export type OverlayState = "drawn" | "absent" | "unknown";
export type FrameBox = { top: number; bottom: number; left: number; right: number };

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const KIND_RANK: Record<FrameKind, number> = { first: 0, last: 1, broll: 2, every_2s: 3 };

export function framePlan(input: { durationS: number; frameCount: number; fps: number; broll: { start_s: number; duration_s: number }[] }): PlannedFrame[] {
  const last = Math.max(0, input.frameCount - 1);
  const nAt = (t: number) => Math.min(last, Math.max(0, Math.round(t * input.fps)));
  const wanted: { n: number; kind: FrameKind }[] = [{ n: 0, kind: "first" }, { n: last, kind: "last" }];
  for (const cut of input.broll) wanted.push({ n: nAt(cut.start_s + cut.duration_s / 2), kind: "broll" });
  for (let k = 1; k * VISUAL_QA.frame_every_s < input.durationS; k++) wanted.push({ n: nAt(k * VISUAL_QA.frame_every_s), kind: "every_2s" });

  // One frame per n; the more important kind wins (first, last, b-roll, then the 2 s ones).
  const byN = new Map<number, FrameKind>();
  for (const w of wanted.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind])) if (!byN.has(w.n)) byN.set(w.n, w.kind);
  let frames = [...byN].map(([n, kind]) => ({ n, kind }));

  if (frames.length > VISUAL_QA.max_frames) {
    const fixed = frames.filter((f) => f.kind !== "every_2s");
    const regular = frames.filter((f) => f.kind === "every_2s").sort((a, b) => a.n - b.n);
    const room = Math.max(0, VISUAL_QA.max_frames - fixed.length);
    const kept = room <= 1 ? regular.slice(0, room) : Array.from({ length: room }, (_, i) => regular[Math.round((i * (regular.length - 1)) / (room - 1))]);
    frames = [...fixed, ...kept];
  }
  return frames.sort((a, b) => a.n - b.n).map((f) => ({ n: f.n, at_seconds: round3(f.n / input.fps), kind: f.kind }));
}

/** The caption page on screen at `t` (its lines joined with " / "), or "". */
export function captionAt(manifest: EditManifest, t: number): string {
  const page = manifest.captions.find((p) => p.start_s <= t && t < p.end_s);
  return page ? page.lines.map((line) => line.map((w) => w.text).join(" ")).join(" / ") : "";
}

/** A binary gray PGM (P5, 8 bit) as written by ffmpeg; y0 = the frame row its first row came from. */
export function parsePgm(bytes: Uint8Array, y0: number): GrayBand {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 64));
  const m = head.match(/^P5\s+(\d+)\s+(\d+)\s+255\s/);
  if (!m) throw new Error("The frame strip is not a gray 8-bit PGM.");
  const width = Number(m[1]);
  const height = Number(m[2]);
  const offset = m[0].length;
  const data = bytes.subarray(offset, offset + width * height);
  if (data.length !== width * height) throw new Error("The frame strip is cut short.");
  return { width, height, y0, data };
}

/** Where the AI label and the trial corner tag are drawn (from EDIT_OVERLAYS; no copied numbers). */
export function overlayRegions(): { label: OverlayRegion; tag: OverlayRegion } {
  const em = VISUAL_QA.pixel.text_width_em;
  const l = EDIT_OVERLAYS.label;
  const labelW = Math.floor(l.chars * l.size * em);
  const w = EDIT_OVERLAYS.watermark;
  const tagW = Math.floor(w.chars * w.size * em);
  const tagRight = CAPTION_LAYOUT.width - w.x; // drawtext x = w - tw - x: the text's right edge
  const labelRows = { y0: l.y - l.pad + 2, y1: l.y - 2 };
  const tagRows = { y0: w.y - w.pad + 2, y1: w.y - 2 };
  return {
    label: {
      pad: { x0: l.x - l.pad + 2, x1: l.x + labelW, ...labelRows },
      text: { x0: l.x, x1: l.x + labelW, y0: l.y, y1: l.y + l.size },
      outside: { x0: l.x - l.pad - 40, x1: l.x - l.pad - 4, ...labelRows },
      alpha: boxAlpha(l.box_colour),
    },
    tag: {
      pad: { x0: tagRight - tagW, x1: tagRight + w.pad - 2, ...tagRows },
      text: { x0: tagRight - tagW, x1: tagRight, y0: w.y, y1: w.y + w.size },
      outside: { x0: tagRight + w.pad + 4, x1: tagRight + w.pad + 40, ...tagRows },
      alpha: boxAlpha(w.box_colour),
    },
  };
}

/** "black@0.55" → 0.55 (the drawtext boxcolor alpha). */
function boxAlpha(colour: string): number {
  const alpha = Number(colour.split("@")[1]);
  if (!colour.startsWith("black@") || !(alpha > 0 && alpha <= 1)) throw new Error(`Unexpected box colour ${colour}`);
  return alpha;
}

/** Limited-range black (the luma of black in our yuv420p H.264 output). */
const BLACK_LUMA = 16;

function pixels(band: GrayBand, r: Region): number[] {
  const out: number[] = [];
  for (let y = Math.max(r.y0, band.y0); y < Math.min(r.y1, band.y0 + band.height); y++) {
    for (let x = Math.max(0, r.x0); x < Math.min(r.x1, band.width); x++) out.push(band.data[(y - band.y0) * band.width + x]);
  }
  return out;
}

const mean = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length;

/**
 * Is the drawtext box there? The box rows above the text must be the background beside the box
 * darkened by the box's alpha (a dark stock clip with bright shapes is NOT), and the text rows must
 * hold bright letter pixels. Near-black backgrounds can't show the box: "unknown".
 */
export function overlayDrawn(band: GrayBand, region: OverlayRegion): OverlayState {
  const p = VISUAL_QA.pixel;
  const pad = pixels(band, region.pad);
  const text = pixels(band, region.text);
  const outside = pixels(band, region.outside);
  if (pad.length === 0 || text.length === 0 || outside.length === 0) return "unknown";
  const out = mean(outside);
  if ((out - BLACK_LUMA) * region.alpha < p.min_contrast) return "unknown";
  const expected = out * (1 - region.alpha) + BLACK_LUMA * region.alpha;
  const bright = text.filter((v) => v >= p.text_min_luma).length / text.length;
  return Math.abs(mean(pad) - expected) <= p.box_tolerance && bright >= p.text_min_share ? "drawn" : "absent";
}

const hard = (code: string, detail: string, at_seconds: number | null = null): QaIssue => ({ code, detail, at_seconds, severity: "hard" });

/** Label (when ai_label), tag (only and always on trial videos), checked on every sampled frame; one issue per problem. */
export function pixelIssues(input: { frames: { at_seconds: number; band: GrayBand }[]; aiLabel: boolean; watermark: boolean }): QaIssue[] {
  const r = overlayRegions();
  const total = input.frames.length;
  const where = (bad: { at_seconds: number }[]) => `in ${bad.length} of ${total} sampled frames (first at ${bad[0].at_seconds} s)`;
  const issues: QaIssue[] = [];
  const unverified = (code: string, what: string): QaIssue => ({
    code, detail: `${what} could not be checked by pixels (every sampled frame is too dark there).`, at_seconds: null, severity: "soft",
  });
  // "unknown" frames (too dark to tell) count neither way.
  if (input.aiLabel) {
    const states = input.frames.map((f) => ({ ...f, state: overlayDrawn(f.band, r.label) }));
    const bad = states.filter((f) => f.state === "absent");
    if (bad.length > 0) issues.push(hard("label_missing", `The "AI-generated" label is not visible ${where(bad)}.`, bad[0].at_seconds));
    else if (states.every((f) => f.state === "unknown")) issues.push(unverified("label_unverified", 'The "AI-generated" label'));
  }
  const tagged = input.frames.map((f) => ({ ...f, state: overlayDrawn(f.band, r.tag) }));
  if (input.watermark) {
    const bad = tagged.filter((f) => f.state === "absent");
    if (bad.length > 0) issues.push(hard("watermark_missing", `The trial "TRIAL PREVIEW" tag is not visible ${where(bad)}.`, bad[0].at_seconds));
    else if (tagged.every((f) => f.state === "unknown")) issues.push(unverified("watermark_unverified", 'The trial "TRIAL PREVIEW" tag'));
  } else {
    const bad = tagged.filter((f) => f.state === "drawn");
    if (bad.length > 0) issues.push(hard("watermark_unexpected", `A trial tag seems drawn on a paid video ${where(bad)}.`, bad[0].at_seconds));
  }
  return issues;
}

/**
 * The face (rubric face_box, chin = bottom) must end above CAPTION_LAYOUT.face_zone.bottom: captions
 * and the big trial mark are placed assuming it does. Below it, our face-zone ESTIMATE is wrong for
 * this twin: never auto-fixed (moving captions would only hide it), the team checks the framing.
 */
export function faceZoneIssues(input: { face: FrameBox | null; watermark: boolean }): QaIssue[] {
  if (!input.face) return [];
  const limit = CAPTION_LAYOUT.face_zone.bottom;
  const bottom = Math.round(input.face.bottom);
  if (bottom <= limit) return [];
  const c = EDIT_OVERLAYS.watermark_centre;
  const stripTop = Math.round(c.y_centre - (c.size * c.height_em) / 2);
  const trial = input.watermark
    ? bottom > stripTop
      ? ` It reaches the big "TRIAL PREVIEW" strip (from y=${stripTop}).`
      : ` It is close to the big "TRIAL PREVIEW" strip (from y=${stripTop}).`
    : "";
  return [
    hard(
      "face_zone_estimate",
      `The face reaches y=${bottom}, below our face-zone estimate (bottom y=${limit}): the face-zone estimate is wrong for this twin, so captions may cover the chin or mouth.${trial} The team must check the framing; this is not fixed automatically.`,
    ),
  ];
}

const FIELD_CODES: Record<(typeof VISUAL_QA_FIELDS)[number], { code: string; soft: boolean; plain: string }> = {
  face_natural: { code: "face_glitch", soft: false, plain: "The face looks unnatural (warping, double edges, teeth or eyes)." },
  mouth_area_clean: { code: "mouth_blur", soft: false, plain: "The mouth area is blurred or smeared." },
  hands_ok: { code: "hands", soft: false, plain: "The hands look wrong." },
  background_stable: { code: "background_flicker", soft: false, plain: "The background flickers or changes." },
  captions_readable: { code: "captions_unreadable", soft: false, plain: "The captions are hard to read or cut off." },
  captions_clear_of_face: { code: "captions_over_face", soft: false, plain: "The captions cover the eyes or mouth." },
  broll_matches_line: { code: "broll_off_topic", soft: true, plain: "A b-roll clip does not fit what is being said." },
  no_stray_text: { code: "stray_text", soft: false, plain: "There is stray text, a logo or a watermark in the video." },
  first_frame_strong: { code: "weak_first_frame", soft: true, plain: "The first frame is weak as a thumbnail." },
};

/** The rubric (QA-SPEC table) → issues. at_seconds comes from the frame index Claude named. */
export function rubricIssues(answer: VisualQaOutput, frames: { at_seconds: number; kind: FrameKind }[]): QaIssue[] {
  const issues: QaIssue[] = [];
  const frame = (i: number) => (Number.isInteger(i) && i >= 0 && i < frames.length ? frames[i] : null);
  for (const field of VISUAL_QA_FIELDS) {
    if (answer[field]) continue;
    const def = FIELD_CODES[field];
    const notes = answer.issues.filter((i) => i.field === field);
    const severity = def.soft ? ("soft" as const) : ("hard" as const);
    if (notes.length === 0) {
      issues.push({ code: def.code, detail: def.plain, at_seconds: null, severity });
      continue;
    }
    for (const note of notes) {
      const f = frame(note.frame);
      // Stray text in a b-roll frame comes from the stock clip (swap it); elsewhere it does not.
      const code = field === "no_stray_text" && f?.kind === "broll" ? "broll_stray_text" : def.code;
      issues.push({ code, detail: `${def.plain} ${note.detail}`.trim(), at_seconds: f?.at_seconds ?? null, severity });
    }
  }
  if (answer.realism_score < VISUAL_QA.pass_realism_score) {
    const note = answer.issues.find((i) => i.field === "realism_score");
    const f = note ? frame(note.frame) : null;
    issues.push(
      hard("realism", `Realism score ${answer.realism_score} (passes at ${VISUAL_QA.pass_realism_score}).${note ? ` ${note.detail}` : ""}`, f?.at_seconds ?? null),
    );
  }
  return issues;
}

export type VisualFix =
  | { kind: "reedit"; captionStyle: CaptionStyleName | null; avoidClips: string[]; note: string }
  | { kind: "rerender"; note: string }
  | { kind: "team" };

/** A fresh render on the same engine can fix these (QA-SPEC: "for a face or realism problem, re-render once"). */
const RENDER_CODES = new Set(["face_glitch", "mouth_blur", "hands", "background_flicker", "realism"]);
/** A re-edit can fix these (QA-SPEC: "for a b-roll or caption problem, swap the clip or adjust the layout"). */
const CAPTION_CODES = new Set(["captions_over_face", "captions_unreadable"]);
const BROLL_CODES = new Set(["broll_stray_text"]);

/** The first fix style whose 2-line caption box starts LOWER (further from the face) than the current one. */
export function nextCaptionStyle(current: CaptionStyleName): CaptionStyleName | null {
  const top = captionBoxTop(current, MAX_PAGE_LINES);
  return VISUAL_QA.caption_fix_styles.find((s) => captionBoxTop(s, MAX_PAGE_LINES) > top) ?? null;
}

/**
 * The ONE automatic fix for the hard issues. Anything we don't know how to fix (face-zone estimate,
 * label/tag pixels, stray text on the face, Claude unavailable, …) → the team. A face/realism problem
 * → re-render (a re-edit would not help; it wins over a caption problem in the same run).
 */
export function classifyFix(issues: QaIssue[], manifest: EditManifest): VisualFix {
  const hardOnes = issues.filter((i) => i.severity === "hard");
  if (hardOnes.length === 0) return { kind: "team" };
  const known = (code: string) => RENDER_CODES.has(code) || CAPTION_CODES.has(code) || BROLL_CODES.has(code);
  if (hardOnes.some((i) => !known(i.code))) return { kind: "team" };
  const codes = [...new Set(hardOnes.map((i) => i.code))];
  if (codes.some((c) => RENDER_CODES.has(c))) {
    return { kind: "rerender", note: `Gate 5: re-rendered once on the same engine (${codes.join(", ")}).` };
  }
  let captionStyle: CaptionStyleName | null = null;
  if (codes.some((c) => CAPTION_CODES.has(c))) {
    captionStyle = nextCaptionStyle(manifest.caption_style);
    if (!captionStyle) return { kind: "team" };
  }
  const avoidClips: string[] = [];
  for (const issue of hardOnes.filter((i) => BROLL_CODES.has(i.code))) {
    const t = issue.at_seconds;
    const cut = t === null ? undefined : manifest.broll.find((c) => c.start_s <= t && t <= c.start_s + c.duration_s);
    if (!cut) return { kind: "team" };
    if (!avoidClips.includes(cut.clip)) avoidClips.push(cut.clip);
  }
  const parts = [
    captionStyle ? `captions moved lower and smaller (${manifest.caption_style} → ${captionStyle})` : null,
    avoidClips.length > 0 ? `b-roll clip swapped (${avoidClips.join(", ")})` : null,
  ].filter(Boolean);
  return { kind: "reedit", captionStyle, avoidClips, note: `Gate 5: re-edited once: ${parts.join("; ")}.` };
}

export type HumanReviewReason = "first_videos" | "realism_margin" | "managed" | "auto_fixed" | "random";

/** Team wording for posts.status_reason / videos.error (the QA queue shows it). */
export const HUMAN_REVIEW_TEXT: Record<HumanReviewReason, string> = {
  first_videos: `One of this brand's first ${HUMAN_REVIEW.first_videos_per_brand} videos: the team watches it before the customer.`,
  realism_margin: `Realism score under ${HUMAN_REVIEW.below_realism_score}: the team watches it before the customer.`,
  managed: "Done-for-you brand: the team watches every video before the customer.",
  auto_fixed: "Auto-fixed: it passed only after one automatic fix, so the team watches it before the customer.",
  random: `Picked at random (1 in ${HUMAN_REVIEW.random_one_in}): the team watches it before the customer.`,
};

/** QA-SPEC Gate 6. The random sample is for "all other videos": only when no other rule applies. */
export function humanReviewReasons(input: {
  /** Other posts of the brand that already passed Gate 5. */
  priorPosts: number;
  realism: number;
  managed: boolean;
  teamReviewsEveryVideo: boolean;
  sampled: boolean;
  /** p5-b4 (QA-SPEC Gate 6 "any video flagged by Gates 3 to 5 after its automatic fix"): it passed only after a fix. */
  autoFixed: boolean;
}): HumanReviewReason[] {
  const reasons: HumanReviewReason[] = [];
  if (input.priorPosts < HUMAN_REVIEW.first_videos_per_brand) reasons.push("first_videos");
  if (input.realism < HUMAN_REVIEW.below_realism_score) reasons.push("realism_margin");
  if (input.managed && input.teamReviewsEveryVideo) reasons.push("managed");
  if (input.autoFixed) reasons.push("auto_fixed");
  if (reasons.length === 0 && input.sampled) reasons.push("random");
  return reasons;
}

/** The random 1 in HUMAN_REVIEW.random_one_in, decided by the video id (a retry decides the same). */
export function sampledForReview(videoId: string): boolean {
  return createHash("sha256").update(videoId).digest().readUInt32BE(0) % HUMAN_REVIEW.random_one_in === 0;
}
