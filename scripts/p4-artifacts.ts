// Phase 4: "Show me before and after files from the fixture video."
// Run by hand: `npm run p4:artifacts` (vitest.artifacts.config.mts runs this
// file; NOT part of `npm test`). Uses only the local ffmpeg/ffprobe, a mock
// transcript, the MOCK_PEXELS b-roll fixtures and the fixture music set, through
// the real edit job (lib/edit-flow.ts runEditJob): no network, no HeyGen, no
// speech-to-text service, nothing paid.
//
// p4-b2: the folder is emptied first, then written again:
//   before-talking.mp4 (+ .png)     the 10 s talking-head stand-in (540x960, 25 fps, face colour, speech-like voice)
//   after-talking-<style>.mp4       story format: captions (each style), b-roll, music, AI label, -14 LUFS, +faststart
//   after-talking-big_words-trial.mp4   + the trial watermark
//   after-talking-big_words-no-label.mp4  ai_label off (payload and row)
//   after-talking-big_words-{hook,broll,broll2,cta}.png   frames at 0.8 s, 4.0 s, 6.5 s, 8.5 s
//   after-talking-big_words-{trial,no-label}-hook.png     frames at 0.8 s
//   after-talking-big_words-trial-broll.png               trial frame at 4.0 s (b-roll under the centre mark, p4-b3)
//   probe.json                       ffprobe summary + loudness (I, TP) + MP4 box order + the ffmpeg commands
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { editForReal, transcriptFor } from "@/tests/helpers/edit-real";
import { grabFrame, hasFfmpeg, loudnessOfFile, makeTalkingInput, measureLoudness, probe, topLevelBoxes } from "@/tests/helpers/ffmpeg-local";
import { CAPTION_STYLE_NAMES, type CaptionStyleName } from "@/lib/captions";
import { audioFilterGraph, getMusicLibrary } from "@/lib/music";

const OUT = path.resolve(process.cwd(), "..", "logs", "p4-artifacts");
const DISPLAY = "Stop scrolling now. Here is how small cafes grow on WhatsApp every week with one simple message. Book a free call today.";
const EDIT_PLAN = {
  broll_moments: [
    { at_words: "small cafes grow", keyword: "coffee shop" },
    { at_words: "with one simple", keyword: "phone" },
  ],
  emphasis_words: ["WhatsApp"],
};
const FRAMES = { hook: 0.8, broll: 4.0, broll2: 6.5, cta: 8.5 } as const;

it("writes the Phase 4 before/after files", async () => {
  expect(hasFfmpeg(), "ffmpeg and ffprobe must be installed").toBe(true);
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  const report: Record<string, unknown> = {};

  const before = path.join(OUT, "before-talking.mp4");
  makeTalkingInput(before, 10, "speech");
  grabFrame(before, FRAMES.hook, path.join(OUT, "before-talking.png"));
  report["before-talking.mp4"] = { ...probe(before), loudness: loudnessOfFile(before) };

  async function one(name: string, style: CaptionStyleName, options: { watermark?: boolean; aiLabel?: boolean } = {}) {
    const outFile = path.join(OUT, `${name}.mp4`);
    const r = await editForReal({
      rawFile: before,
      outFile,
      tmpRoot: OUT,
      job: {
        displayText: DISPLAY, hook: "Stop scrolling now.", cta: "Book a free call today.", transcript: transcriptFor(DISPLAY, 10),
        format: "story", editPlan: EDIT_PLAN, captionStyle: style, brandColour: "#FF5A1F",
        aiLabel: options.aiLabel ?? true, watermark: options.watermark ?? false,
      },
      row: { ai_label: options.aiLabel ?? true },
    });
    expect(r.outcome.status, `${name}: ${JSON.stringify(r.outcome)}`).toBe("edited");
    report[`${name}.mp4`] = {
      ...probe(outFile),
      loudness: loudnessOfFile(outFile),
      mp4_boxes: topLevelBoxes(await readFile(outFile)),
      outcome: r.outcome,
      ffmpeg_commands: r.calls.map((c) => c.args),
      loudnorm_pass2_summary: r.calls.at(-1)?.stderr.match(/Input Integrated[\s\S]*?Normalization Type:\s*\w+/)?.[0] ?? null,
    };
    return outFile;
  }

  for (const style of CAPTION_STYLE_NAMES) {
    const file = await one(`after-talking-${style}`, style);
    if (style === "big_words") {
      for (const [frame, at] of Object.entries(FRAMES)) grabFrame(file, at, path.join(OUT, `after-talking-big_words-${frame}.png`));
    } else {
      grabFrame(file, FRAMES.broll, path.join(OUT, `after-talking-${style}-broll.png`));
    }
  }
  const trial = await one("after-talking-big_words-trial", "big_words", { watermark: true });
  grabFrame(trial, FRAMES.hook, path.join(OUT, "after-talking-big_words-trial-hook.png"));
  // p4-b3: the big faint centre mark + the boxed corner tag over light b-roll.
  grabFrame(trial, FRAMES.broll, path.join(OUT, "after-talking-big_words-trial-broll.png"));
  const noLabel = await one("after-talking-big_words-no-label", "big_words", { aiLabel: false });
  grabFrame(noLabel, FRAMES.hook, path.join(OUT, "after-talking-big_words-no-label-hook.png"));

  // Gate 4 "music 15 dB quieter than the voice": the two stems through the same chain.
  const bed = getMusicLibrary().pick("90000000-0000-4000-8000-0000000000b2");
  const stem = (side: "voice" | "music") =>
    measureLoudness([
      "-i", before, "-stream_loop", "-1", "-i", bed.file,
      "-filter_complex", `${audioFilterGraph({ music: { input: 1, durationS: 10 }, loudness: null, stem: side })};[aout]ebur128=peak=true:framelog=quiet[m]`,
      "-map", "[m]", "-f", "null", "-",
    ]);
  report.stems = { bed: bed.id, voice: stem("voice"), music: stem("music") };
  report.frames_s = FRAMES;

  await writeFile(path.join(OUT, "probe.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.info(`[p4-artifacts] wrote ${Object.keys(report).length - 2} videos to ${OUT}`);
  for (const [name, value] of Object.entries(report)) {
    const v = value as { loudness?: { i: number; tp: number }; mp4_boxes?: string[] };
    if (v.loudness) console.info(`${name}: I=${v.loudness.i} LUFS TP=${v.loudness.tp} dBTP boxes=${v.mp4_boxes?.join(",") ?? "-"}`);
  }
  console.info(`stems: ${JSON.stringify(report.stems)}`);
});
