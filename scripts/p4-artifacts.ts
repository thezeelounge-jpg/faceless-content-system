// Phase 4 part A: "Show me before and after files from the fixture video."
// Run by hand: `npm run p4:artifacts` (vitest.artifacts.config.mts runs this
// file; NOT part of `npm test`). Uses only the local ffmpeg/ffprobe, the mock
// transcript (tests/fixtures/stt/) and lib/captions.ts + lib/edit.ts: no
// network, no HeyGen, no speech-to-text service, nothing paid.
//
// Writes into /workspace/creator-tool/logs/p4-artifacts/ (outside the repo):
//   before-landscape.mp4          1280x720 25 fps test clip (made here)
//   after-landscape-big_words.mp4 the same, edited (1080x1920 30 fps, captions)
//   before-consent-good.mp4       tests/fixtures/consent-good.mp4 copied
//   after-consent-good-<style>.mp4 one per caption style
//   *.png                         one frame at 1.6 s from each, to look at quickly
//   *.ass                         the caption files
//   probe.json                    ffprobe summary of every file
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import script from "@/tests/fixtures/stt/sample-script.json";
import fixture from "@/tests/fixtures/stt/sample-transcript.json";
import { grabFrame, hasFfmpeg, makeLandscapeInput, probe } from "@/tests/helpers/ffmpeg-local";
import { CAPTION_STYLE_NAMES, buildAss, type CaptionStyleName } from "@/lib/captions";
import { buildEditArgs } from "@/lib/edit";
import { captionFontsDir, runFfmpeg } from "@/lib/edit-flow";
import type { Transcript } from "@/lib/stt";

const OUT = path.resolve(process.cwd(), "..", "logs", "p4-artifacts");
const FRAME_AT_S = 1.6; // the word "3" is being said: big_words shows it highlighted
const BRAND_COLOUR = "#FF5A1F";

async function editOne(input: string, style: CaptionStyleName, name: string) {
  const captionsPath = path.join(OUT, `${name}.ass`);
  await writeFile(
    captionsPath,
    buildAss({ displayText: script.display_text, transcript: fixture as Transcript, style, brandColour: BRAND_COLOUR }),
  );
  const output = path.join(OUT, `${name}.mp4`);
  await runFfmpeg(buildEditArgs({ input, output, captionsPath, fontsDir: captionFontsDir() }));
  grabFrame(output, FRAME_AT_S, path.join(OUT, `${name}.png`));
  return output;
}

it("writes the Phase 4 before/after files", async () => {
  expect(hasFfmpeg(), "ffmpeg and ffprobe must be installed").toBe(true);
  await mkdir(OUT, { recursive: true });
  const probes: Record<string, unknown> = {};

  const landscape = path.join(OUT, "before-landscape.mp4");
  makeLandscapeInput(landscape, 6);
  grabFrame(landscape, FRAME_AT_S, path.join(OUT, "before-landscape.png"));
  probes["before-landscape.mp4"] = probe(landscape);
  const after = await editOne(landscape, "big_words", "after-landscape-big_words");
  probes[path.basename(after)] = probe(after);

  const good = path.join(OUT, "before-consent-good.mp4");
  await copyFile(path.join(process.cwd(), "tests", "fixtures", "consent-good.mp4"), good);
  grabFrame(good, FRAME_AT_S, path.join(OUT, "before-consent-good.png"));
  probes["before-consent-good.mp4"] = probe(good);
  for (const style of CAPTION_STYLE_NAMES) {
    const file = await editOne(good, style, `after-consent-good-${style}`);
    probes[path.basename(file)] = probe(file);
  }

  await writeFile(path.join(OUT, "probe.json"), `${JSON.stringify(probes, null, 2)}\n`);
  console.info(`[p4-artifacts] wrote ${Object.keys(probes).length} videos to ${OUT}`);
  console.info(JSON.stringify(probes, null, 2));
});
