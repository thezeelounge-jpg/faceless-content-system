import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REAL_BRAND, REAL_VIDEO, editForReal, transcriptFor } from "@/tests/helpers/edit-real";
import {
  FACE_RGB,
  hasFfmpeg,
  loudnessOfFile,
  makeTalkingInput,
  meanDiff,
  measureLoudness,
  pixelAt,
  probe,
  regionAt,
  topLevelBoxes,
} from "@/tests/helpers/ffmpeg-local";
import { CAPTION_LAYOUT, CAPTION_STYLE_NAMES, buildAss, estimatePageBox } from "@/lib/captions";
import { EDIT_OVERLAYS, buildEditArgs } from "@/lib/edit";
import { captionFontsDir, runFfmpeg } from "@/lib/edit-flow";
import { audioFilterGraph, getMusicLibrary } from "@/lib/music";
import { LOUDNESS, MUSIC } from "@/lib/qa/config";
import type { Transcript } from "@/lib/stt";

// p4-b2 with the REAL local ffmpeg/ffprobe: the whole edit job (runEditJob:
// ffprobe → b-roll plan + mock clips → music bed → loudness pass 1 → final
// encode with pass 2), then the output is measured: format, loudness, true
// peak, moov before mdat, b-roll vs face pixels at planned times, captions on
// top of b-roll, music vs voice stems, label/watermark areas. Mock speech-to-
// text timings (a transcript in the payload), MOCK_PEXELS clips, the fixture
// music set: no network, nothing paid. Work folder name holds : ' [ ] , ; \.

const FFMPEG = hasFfmpeg();
const BRAND = REAL_BRAND;
const VIDEO = REAL_VIDEO;

const B_GREEN: [number, number, number] = [0x1e, 0x8c, 0x3a]; // tests/fixtures/broll/cafe-green.mp4
const B_MAGENTA: [number, number, number] = [0xc2, 0x18, 0x7a]; // tests/fixtures/broll/phone-magenta.mp4
const CENTRE = { x: 540, y: 760 }; // the face zone: no captions, no label

/** 10 s talking reel: 22 words, one every 0.42 s from 0.2 s. */
const DISPLAY = "Stop scrolling now. Here is how small cafes grow on WhatsApp every week with one simple message. Book a free call today.";
const HOOK = "Stop scrolling now.";
const CTA = "Book a free call today.";
// Hook ends 1.40 s; "small cafes grow" 2.72 s; "with one simple" 5.66 s; the CTA starts 7.34 s.
// Story plan: cut 1 = 2.72 → 5.16 (shortened to leave a 0.5 s face gap), cut 2 = 5.66 → 7.34.
const EDIT_PLAN = {
  broll_moments: [
    { at_words: "small cafes grow", keyword: "coffee shop" },
    { at_words: "with one simple", keyword: "phone" },
  ],
  emphasis_words: ["WhatsApp"],
};

let root: string;
let work: string;

beforeAll(async () => {
  if (!FFMPEG) return;
  root = await mkdtemp(path.join(os.tmpdir(), "p4b2-it-"));
  work = path.join(root, "a:b's [x],y;z\\w");
  await mkdir(work);
});
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

/** runEditJob with real ffmpeg/ffprobe (tests/helpers/edit-real.ts). */
type RealJob = {
  displayText: string; hook: string; cta: string; transcript: Transcript; format: "talking" | "story";
  editPlan?: { broll_moments: { at_words: string; keyword: string }[]; emphasis_words: string[] };
};
const editReal = (rawFile: string, name: string, job: RealJob) =>
  editForReal({
    rawFile,
    outFile: path.join(work, `${name}.mp4`),
    tmpRoot: work,
    job: { editPlan: EDIT_PLAN, ...job, captionStyle: "big_words", brandColour: "#FF5A1F", aiLabel: true, watermark: false },
  });

const close = (got: number[], want: number[], tol = 22) => got.every((v, i) => Math.abs(v - want[i]) <= tol);

if (!FFMPEG) console.warn("[edit-extras-ffmpeg] SKIPPED: ffmpeg/ffprobe are not installed on this machine.");

describe.skipIf(!FFMPEG)("p4-b2 editor extras with real ffmpeg", () => {
  let full: Awaited<ReturnType<typeof editForReal>>;
  let raw: string;

  beforeAll(async () => {
    raw = path.join(work, "talking.mp4");
    makeTalkingInput(raw, 10, "speech");
    full = await editReal(raw, "story-full", {
      displayText: DISPLAY, hook: HOOK, cta: CTA, transcript: transcriptFor(DISPLAY, 10), format: "story",
    });
  }, 60_000);

  it("the job finishes into final_qa (every requested extra is in the real argv): 2 ffmpeg runs", () => {
    expect(full.outcome).toEqual({ status: "edited", finalPath: `final/${BRAND}/${VIDEO}/runs/run_real.mp4`, notApplied: [] });
    expect(full.row.status).toBe("final_qa");
    expect(full.calls).toHaveLength(2);
  });

  it("format: 1080x1920, 30/1 fps, H.264 yuv420p, AAC 48 kHz stereo, length kept", () => {
    const p = probe(full.output);
    console.info(`[ffprobe] story-full ${JSON.stringify(p)}`);
    expect(p).toMatchObject({
      width: 1080, height: 1920, r_frame_rate: "30/1", avg_frame_rate: "30/1",
      video_codec: "h264", pix_fmt: "yuv420p", audio_codec: "aac", sample_rate: "48000", channels: 2,
    });
    expect(Math.abs(p.duration_s - 10)).toBeLessThanOrEqual(0.15);
  });

  it("loudness: -14 LUFS ±1 integrated, true peak ≤ -1.0 dBTP (two-pass loudnorm, measured on the final AAC)", () => {
    const l = loudnessOfFile(full.output);
    console.info(`[loudness] story-full I=${l.i} LUFS TP=${l.tp} dBTP`);
    expect(Math.abs(l.i - LOUDNESS.target_i)).toBeLessThanOrEqual(LOUDNESS.tolerance_lu);
    expect(l.tp).toBeLessThanOrEqual(LOUDNESS.max_true_peak_db);
  });

  it("+faststart: the moov box comes before mdat (top-level boxes read from the file bytes)", async () => {
    const boxes = topLevelBoxes(await readFile(full.output));
    console.info(`[mp4 boxes] ${boxes.join(" ")}`);
    expect(boxes.indexOf("moov")).toBeGreaterThanOrEqual(0);
    expect(boxes.indexOf("moov")).toBeLessThan(boxes.indexOf("mdat"));
  });

  it("face at the hook and the CTA; b-roll at the planned times; face between cuts", () => {
    const samples = {
      hook: pixelAt(full.output, 0.8, CENTRE.x, CENTRE.y),
      afterHook: pixelAt(full.output, 1.9, CENTRE.x, CENTRE.y),
      cut1: pixelAt(full.output, 4.0, CENTRE.x, CENTRE.y),
      gap: pixelAt(full.output, 5.4, CENTRE.x, CENTRE.y),
      cut2: pixelAt(full.output, 6.5, CENTRE.x, CENTRE.y),
      cta: pixelAt(full.output, 8.5, CENTRE.x, CENTRE.y),
    };
    console.info(`[pixels] ${JSON.stringify(samples)}`);
    expect(close(samples.hook, FACE_RGB)).toBe(true);
    expect(close(samples.afterHook, FACE_RGB)).toBe(true);
    expect(close(samples.cut1, B_GREEN)).toBe(true);
    expect(close(samples.gap, FACE_RGB)).toBe(true);
    expect(close(samples.cut2, B_MAGENTA)).toBe(true);
    expect(close(samples.cta, FACE_RGB)).toBe(true);
  });

  it("captions stay on top of the b-roll (white caption text in the caption band during a cut)", () => {
    const band = regionAt(full.output, 4.0, 140, 1150, 800, 350);
    let white = 0;
    for (let i = 0; i < band.length; i += 3) if (band[i] > 230 && band[i + 1] > 230 && band[i + 2] > 230) white += 1;
    expect(white).toBeGreaterThan(2000);
  });

  it("music stem ≥ 15 dB quieter than the voice stem (same chain, one side rendered at a time)", () => {
    const bed = getMusicLibrary().pick(VIDEO);
    const stem = (side: "voice" | "music") =>
      measureLoudness([
        "-i", raw, "-stream_loop", "-1", "-i", bed.file,
        "-filter_complex", `${audioFilterGraph({ music: { input: 1, durationS: 10 }, loudness: null, stem: side })};[aout]ebur128=peak=true:framelog=quiet[m]`,
        "-map", "[m]", "-f", "null", "-",
      ]);
    const voice = stem("voice");
    const music = stem("music");
    console.info(`[stems] voice I=${voice.i} LUFS, music I=${music.i} LUFS, gap ${(voice.i - music.i).toFixed(1)} dB (bed ${bed.id})`);
    expect(Number.isFinite(music.i)).toBe(true); // the music is really there
    expect(voice.i - music.i).toBeGreaterThanOrEqual(MUSIC.min_voice_over_music_db);
  });

  // PERMANENT REGRESSION (p4-b3, Rowan item 5): the hard loudness case. A quiet voice (~-27 LUFS)
  // with full-scale clicks (0 dBTP) needs ~13 dB of gain AND a peak cut: loudnorm falls back to
  // dynamic mode here. The fixture is deterministic (tests/helpers/ffmpeg-local.ts makeTalkingInput
  // "peaky": an aevalsrc formula, no noise, no random seed). Bounds are literal numbers on purpose,
  // so a config change can't quietly loosen them: integrated -14 ±1 LUFS, true peak ≤ -1.0 dBTP.
  it("REGRESSION hard case: quiet voice + full-scale clicks → -15 ≤ I ≤ -13 LUFS and TP ≤ -1.0 dBTP", async () => {
    const peaky = path.join(work, "peaky.mp4");
    makeTalkingInput(peaky, 4, "peaky");
    const input = loudnessOfFile(peaky);
    // The fixture must stay HARD: quiet and peaking at full scale (else this test proves nothing).
    expect(input.i).toBeLessThanOrEqual(-25);
    expect(input.tp).toBeGreaterThanOrEqual(-0.5);
    const text = "Stop now. Book today.";
    const r = await editReal(peaky, "peaky-final", {
      displayText: text, hook: "Stop now.", cta: "Book today.", transcript: transcriptFor(text, 4, 0.9), format: "talking",
      editPlan: { broll_moments: [], emphasis_words: [] }, // face only: this case is about the audio
    });
    expect(r.outcome.status).toBe("edited");
    const l = loudnessOfFile(r.output);
    console.info(`[loudness] REGRESSION peaky I=${l.i} LUFS TP=${l.tp} dBTP (input I=${input.i} TP=${input.tp})`);
    expect(l.i).toBeGreaterThanOrEqual(-15);
    expect(l.i).toBeLessThanOrEqual(-13);
    expect(l.tp).toBeLessThanOrEqual(-1.0);
    // And the shared config agrees with those literal bounds.
    expect([LOUDNESS.target_i, LOUDNESS.tolerance_lu, LOUDNESS.max_true_peak_db]).toEqual([-14, 1, -1]);
  }, 30_000);
});

describe.skipIf(!FFMPEG)("p4-b2 AI label and trial watermark with real ffmpeg", () => {
  // Short 2 s clips through the same builder: on/off only changes the label/watermark areas.
  const variants = { both: { ai_label: true, watermark: true }, label: { ai_label: true, watermark: false }, none: { ai_label: false, watermark: false } };
  const out: Record<keyof typeof variants, string> = { both: "", label: "", none: "" };

  beforeAll(async () => {
    const input = path.join(work, "short.mp4");
    makeTalkingInput(input, 2, "speech");
    const captionsPath = path.join(work, "short.ass");
    const text = "Stop now.";
    await writeFile(captionsPath, buildAss({ displayText: text, transcript: transcriptFor(text, 2), style: "big_words" }));
    for (const [name, extras] of Object.entries(variants) as [keyof typeof variants, (typeof variants)["both"]][]) {
      out[name] = path.join(work, `label-${name}.mp4`);
      await runFfmpeg(buildEditArgs({ input, output: out[name], captionsPath, fontsDir: captionFontsDir(), durationS: 2, extras }));
    }
  }, 60_000);

  const l = EDIT_OVERLAYS.label;
  const labelArea = (file: string) => regionAt(file, 1, CAPTION_SAFE_LEFT, l.y - l.pad, 280, 70);
  const watermarkArea = (file: string) => regionAt(file, 1, 500, 250, 440, 72);
  const CAPTION_SAFE_LEFT = 140;

  it("the label area changes when ai_label is on, and is just the face when it is off", () => {
    const on = meanDiff(labelArea(out.label), labelArea(out.none));
    console.info(`[label] mean diff on vs off = ${on.toFixed(1)}`);
    expect(on).toBeGreaterThan(20);
    expect(close(pixelAt(out.none, 1, 160, 280), FACE_RGB)).toBe(true);
  });

  it("the watermark shows only for trial videos, and does not touch the label", () => {
    const trial = meanDiff(watermarkArea(out.both), watermarkArea(out.label));
    const paid = meanDiff(watermarkArea(out.label), watermarkArea(out.none));
    const labelSame = meanDiff(labelArea(out.both), labelArea(out.label));
    console.info(`[watermark] trial vs not = ${trial.toFixed(1)}, not-trial label vs none = ${paid.toFixed(2)}, label area both vs label = ${labelSame.toFixed(2)}`);
    expect(trial).toBeGreaterThan(10);
    expect(paid).toBeLessThan(1);
    expect(labelSame).toBeLessThan(1);
  });

  it("p5-a3: the big faint centre 'TRIAL PREVIEW' is drawn only on trial videos, in the gap between the face and the captions", () => {
    // Changed pixels (trial vs not) from below the corner tag down to the QA bottom 20% (y 1536).
    // Both files carry the same captions, so only the centre mark differs here, plus x264 noise:
    // a few scattered pixels (≤ 11 a row, measured) at the sharp caption edges. The mark is one
    // solid block of rows (400+ changed pixels each): core rows ≥ 50 px, grown to every touching
    // row with any change (its faint anti-aliased edges); every row outside it must be noise only.
    const top = 400;
    const height = 1536 - top;
    const a = regionAt(out.both, 1, 0, top, 1080, height);
    const b = regionAt(out.label, 1, 0, top, 1080, height);
    const rows = new Array<number>(height).fill(0);
    const xs: [number, number][] = Array.from({ length: height }, () => [1080, -1]);
    let changed = 0;
    for (let p = 0; p < a.length; p += 3) {
      const d = Math.max(Math.abs(a[p] - b[p]), Math.abs(a[p + 1] - b[p + 1]), Math.abs(a[p + 2] - b[p + 2]));
      if (d <= 8) continue;
      changed += 1;
      const x = (p / 3) % 1080;
      const r = Math.floor(p / 3 / 1080);
      rows[r] += 1;
      xs[r] = [Math.min(xs[r][0], x), Math.max(xs[r][1], x)];
    }
    const core = rows.flatMap((n, r) => (n >= 50 ? [r] : []));
    expect(core.length).toBeGreaterThan(0);
    let r0 = core[0];
    let r1 = core.at(-1)!;
    expect(core.length).toBe(r1 - r0 + 1); // ONE block of solid rows
    while (r0 > 0 && rows[r0 - 1] > 0) r0 -= 1;
    while (r1 < height - 1 && rows[r1 + 1] > 0) r1 += 1;
    const noise = Math.max(0, ...rows.filter((_, r) => r < r0 || r > r1));
    expect(noise).toBeLessThanOrEqual(20);
    const block = xs.slice(r0, r1 + 1);
    const x0 = Math.min(...block.map(([lo]) => lo));
    const x1 = Math.max(...block.map(([, hi]) => hi));
    const y0 = top + r0;
    const y1 = top + r1;
    const c = EDIT_OVERLAYS.watermark_centre;
    const width = x1 - x0 + 1;
    console.info(`[watermark centre] box x ${x0}-${x1} (${width} px = ${(width / c.size).toFixed(2)} em) y ${y0}-${y1}, ${changed} px changed, noise ≤ ${noise} px a row elsewhere`);
    expect(changed).toBeGreaterThan(5000);
    expect(width).toBeGreaterThanOrEqual(c.width_em[0] * c.size);
    expect(width).toBeLessThanOrEqual(c.width_em[1] * c.size);
    expect(width / 1080).toBeGreaterThanOrEqual(0.5);
    expect(x0).toBeGreaterThanOrEqual(CAPTION_LAYOUT.safe.left);
    expect(x1).toBeLessThanOrEqual(CAPTION_LAYOUT.width - CAPTION_LAYOUT.safe.right);
    expect(y1 - y0 + 1).toBeLessThanOrEqual(c.height_em * c.size);
    // The drawn box lies in the gap: below the face zone, above the highest caption box of any
    // style at 2 lines (estimatePageBox), with ≥ 4 px on both sides; so it overlaps neither.
    const captionTop = Math.min(
      ...CAPTION_STYLE_NAMES.map((name) => {
        const line = () => [{ text: "W", start_s: 0, end_s: 1, source: "matched" as const, stt_indexes: [0] }];
        return estimatePageBox({ lines: [line(), line()], start_s: 0, end_s: 1, scale: 1 }, name).top;
      }),
    );
    console.info(`[watermark centre] gap y ${CAPTION_LAYOUT.face_zone.bottom}-${captionTop}`);
    expect(y0).toBeGreaterThanOrEqual(CAPTION_LAYOUT.face_zone.bottom + 4);
    expect(y1).toBeLessThanOrEqual(captionTop - 4);
    // Faint: the face shows through (35% white), it is not painted over.
    const mid = pixelAt(out.both, 1, Math.round((x0 + x1) / 2), Math.round((y0 + y1) / 2));
    console.info(`[watermark centre] a pixel near the middle: ${JSON.stringify(mid)}`);
    // Paid videos: nothing in the gap.
    const gap = (file: string) => regionAt(file, 1, 140, CAPTION_LAYOUT.face_zone.bottom, 800, captionTop - CAPTION_LAYOUT.face_zone.bottom);
    expect(meanDiff(gap(out.label), gap(out.none))).toBeLessThan(1);
  });
});
