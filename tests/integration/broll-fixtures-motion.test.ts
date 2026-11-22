import path from "node:path";
import { describe, expect, it } from "vitest";
import { runFfmpeg } from "@/lib/edit-flow";
import { TECH_QA } from "@/lib/qa/config";
import { parseFreezedetect } from "@/lib/qa/technical-checks";
import { hasFfmpeg } from "@/tests/helpers/ffmpeg-local";
import catalogue from "@/tests/fixtures/broll/catalogue.json";

// p5-b1 (Rowan 2): the MOCK_PEXELS b-roll clips (tests/fixtures/broll, made by `npm run fixtures`)
// must move a little, so a local mock run never trips Gate 4's freezedetect on a b-roll cut longer
// than TECH_QA.max_freeze_s. Real local ffmpeg, the same freezedetect settings Gate 4 uses
// (finalMeasureArgs). Video only, a few seconds per clip, nothing written.

const FFMPEG = hasFfmpeg();
const DIR = path.join(process.cwd(), "tests", "fixtures", "broll");
const clips = Object.values(catalogue.clips);

describe.runIf(FFMPEG)("mock b-roll fixtures move (no freeze over the Gate 4 limit)", () => {
  it.each(clips.map((c) => [c.file, c.duration_s] as const))("%s", async (file, durationS) => {
    const { stderr } = await runFfmpeg(
      [
        "-nostdin", "-hide_banner", "-nostats", "-i", path.join(DIR, file), "-an",
        "-vf", `freezedetect=n=${TECH_QA.freeze_noise_db}dB:d=${TECH_QA.freeze_report_s}`,
        "-f", "null", "-",
      ],
      { timeoutS: 60 },
    );
    const freezes = parseFreezedetect(stderr, durationS);
    const longest = Math.max(0, ...freezes.map((f) => f.end_s - f.start_s));
    expect(longest, `${file} freezes: ${JSON.stringify(freezes)}`).toBeLessThanOrEqual(TECH_QA.max_freeze_s);
  });
});
