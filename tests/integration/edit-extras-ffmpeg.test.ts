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
import { buildAss } from "@/lib/captions";
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
const editReal = (rawFile: string, name: string, job: { displayText: string; hook: string; cta: string; transcript: Transcript; format: "talking" | "story" }) =>
  editForReal({
    rawFile,
    outFile: path.join(work, `${name}.mp4`),
    tmpRoot: work,
    job: { ...job, editPlan: EDIT_PLAN, captionStyle: "big_words", brandColour: "#FF5A1F", aiLabel: true, watermark: false },
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
    expect(full.outcome).toEqual({ status: "edited", finalPath: `final/${BRAND}/${VIDEO}.mp4`, notApplied: [] });
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

  it("a peaky, quiet voice (big gain needed) still lands on -14 ±1 LUFS with true peak ≤ -1.0 dBTP", async () => {
    const peaky = path.join(work, "peaky.mp4");
    makeTalkingInput(peaky, 4, "peaky");
    const text = "Stop now. Book today.";
    const r = await editReal(peaky, "peaky-final", { displayText: text, hook: "Stop now.", cta: "Book today.", transcript: transcriptFor(text, 4, 0.9), format: "talking" });
    expect(r.outcome.status).toBe("edited");
    const l = loudnessOfFile(r.output);
    console.info(`[loudness] peaky I=${l.i} LUFS TP=${l.tp} dBTP (input ${JSON.stringify(loudnessOfFile(peaky))})`);
    expect(Math.abs(l.i - LOUDNESS.target_i)).toBeLessThanOrEqual(LOUDNESS.tolerance_lu);
    expect(l.tp).toBeLessThanOrEqual(LOUDNESS.max_true_peak_db);
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
});
