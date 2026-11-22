import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import script from "@/tests/fixtures/stt/sample-script.json";
import fixture from "@/tests/fixtures/stt/sample-transcript.json";
import { hasFfmpeg, makeLandscapeInput, probe } from "@/tests/helpers/ffmpeg-local";
import { CAPTION_STYLES, buildAss, type CaptionStyleName } from "@/lib/captions";
import { buildEditArgs } from "@/lib/edit";
import { captionFontsDir, runFfmpeg } from "@/lib/edit-flow";
import type { Transcript } from "@/lib/stt";

// The REAL ffmpeg/ffprobe on this machine run the exact args from lib/edit.ts
// (no mocks for ffmpeg; speech-to-text = the mock fixture). Outputs go only
// to a temp folder whose name holds : ' [ ] , ; \ so the filtergraph escaping
// is tested for real. Skipped only when ffmpeg/ffprobe are not installed.
// Checked: 1080x1920, 30/1 fps, h264 yuv420p, AAC 48 kHz stereo, square
// pixels, duration within 0.15 s of the input, and libass using OUR fonts.

const FFMPEG = hasFfmpeg();
const GOOD_CLIP = path.join(process.cwd(), "tests", "fixtures", "consent-good.mp4");

let root: string;
let work: string;

beforeAll(async () => {
  if (!FFMPEG) return;
  root = await mkdtemp(path.join(os.tmpdir(), "p4-edit-it-"));
  work = path.join(root, "a:b's [x],y;z\\w"); // every character escapeFilterValue handles
  await mkdir(work);
});
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

async function edit(input: string, style: CaptionStyleName, name: string) {
  const captionsPath = path.join(work, `${name}.ass`);
  await writeFile(
    captionsPath,
    buildAss({ displayText: script.display_text, transcript: fixture as Transcript, style, brandColour: "#FF5A1F" }),
  );
  const output = path.join(work, `${name}.mp4`);
  const { stderr } = await runFfmpeg(buildEditArgs({ input, output, captionsPath, fontsDir: captionFontsDir() }));
  return { output, stderr };
}

function expectReel(file: string, inputDurationS: number) {
  const p = probe(file);
  console.info(`[ffprobe] ${path.basename(file)} ${JSON.stringify(p)}`);
  expect(p).toMatchObject({
    width: 1080,
    height: 1920,
    r_frame_rate: "30/1",
    avg_frame_rate: "30/1",
    video_codec: "h264",
    pix_fmt: "yuv420p",
    audio_codec: "aac",
    sample_rate: "48000",
    channels: 2,
  });
  expect(p.sar === null || p.sar === "1:1").toBe(true);
  expect(Math.abs(p.duration_s - inputDurationS)).toBeLessThanOrEqual(0.15);
}

if (!FFMPEG) console.warn("[edit-ffmpeg] SKIPPED: ffmpeg/ffprobe are not installed on this machine.");

/**
 * libass logs `fontselect: (<family>, <weight>, <italic>) -> <PostScript name>, ...`.
 * Our files' PostScript names equal their file names without .ttf; a system
 * fallback font would show another name.
 */
const pickedOurFont = (style: CaptionStyleName) =>
  new RegExp(
    `fontselect: \\(${CAPTION_STYLES[style].font}, \\d+, \\d\\) -> ${CAPTION_STYLES[style].font_file.replace(/\.ttf$/, "")},`,
  );

describe.skipIf(!FFMPEG)("editor with real ffmpeg", () => {
  it("has the subtitles filter (libass)", () => {
    expect(execFileSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf8" })).toMatch(/ subtitles +V->V/);
  });

  it("landscape 1280x720 25 fps 44.1 kHz → 1080x1920 30 fps H.264 yuv420p AAC 48 kHz, captions in Anton", async () => {
    const input = path.join(work, "landscape.mp4");
    makeLandscapeInput(input, 6);
    const before = probe(input);
    expect(before).toMatchObject({ width: 1280, height: 720, r_frame_rate: "25/1", sample_rate: "44100" });
    const { output, stderr } = await edit(input, "big_words", "landscape-final");
    expectReel(output, before.duration_s);
    // libass found our bundled font file (not a system fallback).
    expect(stderr).toMatch(pickedOurFont("big_words"));
    // p4-b1 (QA NICE): libass tries to load every file in the fontsdir; text files there log
    // "error opening memory font 'readme.md'". Licences live in assets/fonts/licenses/ now.
    expect(stderr).not.toMatch(/memory font/i);
  });

  it("the consent-good fixture (already 9:16) edits too, with the small_box and minimal fonts", async () => {
    const before = probe(GOOD_CLIP);
    const box = await edit(GOOD_CLIP, "small_box", "good-small-box");
    expectReel(box.output, before.duration_s);
    expect(box.stderr).toMatch(pickedOurFont("small_box"));
    const min = await edit(GOOD_CLIP, "minimal", "good-minimal");
    expect(probe(min.output)).toMatchObject({ width: 1080, height: 1920 });
    expect(min.stderr).toMatch(pickedOurFont("minimal"));
  });
});
