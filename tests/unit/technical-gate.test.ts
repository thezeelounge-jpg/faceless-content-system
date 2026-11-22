import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { alignWords, groupPages } from "@/lib/captions";
import type { FfmpegRunner } from "@/lib/edit-flow";
import { fixtureMusicLibrary } from "@/lib/music";
import type { EditManifest } from "@/lib/qa/edit-manifest";
import { runTechnicalGate, type TechnicalGateDeps } from "@/lib/qa/technical-gate";
import { memoryPipeline } from "@/tests/helpers/pipeline-memory";
import fixed from "@/tests/fixtures/stt/gate3-ayesha-fixed.json";

// Gate 4 (QA-SPEC "Gate 4: Technical QA") runner with fakes: ffprobe JSON and ffmpeg stderr are
// literal text, the "final file" is a tiny MP4 box layout. The real-ffmpeg run is in
// tests/integration/technical-gate-ffmpeg.test.ts.

const AYESHA = {
  displayText: "Hi, I'm Ayesha from Bright Smile Dental. Brush twice a day and floss once. Book your free check-up today.",
  hook: "Hi, I'm Ayesha from Bright Smile Dental.",
  cta: "Book your free check-up today.",
  dictionary: [{ written: "Ayesha", say_as: "Aa-ee-sha", status: "approved" as const }],
};

const box = (type: string, size: number) => {
  const b = Buffer.alloc(size);
  b.writeUInt32BE(size);
  b.write(type, 4, "ascii");
  return b;
};
const FASTSTART_MP4 = new Uint8Array(Buffer.concat([box("ftyp", 24), box("moov", 32), box("mdat", 64)]));

const probe = (fps = "30/1") =>
  JSON.stringify({
    streams: [
      { codec_type: "video", codec_name: "h264", width: 1080, height: 1920, pix_fmt: "yuv420p", avg_frame_rate: fps },
      { codec_type: "audio", codec_name: "aac", sample_rate: "48000" },
    ],
    format: { duration: "7.800000", size: "3100000" },
  });
const summary = (i: number, tp: number) => `[Parsed_ebur128_0 @ 0x1] Summary:\n\n  Integrated loudness:\n    I:  ${i} LUFS\n\n  True peak:\n    Peak:  ${tp} dBFS\n`;

/** Fake ffmpeg: the final-file pass (black/freeze/loudness) and the two stem passes. */
function fakeFfmpeg(final = summary(-14.1, -1.6)): FfmpegRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const run = (async (args: string[]) => {
    calls.push(args);
    const graph = args[args.indexOf("-filter_complex") + 1] ?? "";
    if (graph.includes("blackdetect")) return { stderr: final };
    if (graph.includes("[music]anullsink")) return { stderr: summary(-16.2, -3) }; // the voice stem
    if (graph.includes("[voice]anullsink")) return { stderr: summary(-44.5, -30) }; // the music stem
    throw new Error(`unexpected ffmpeg call ${args.join(" ")}`);
  }) as FfmpegRunner & { calls: string[][] };
  run.calls = calls;
  return run;
}

async function editedVideo(p: ReturnType<typeof memoryPipeline>, manifest?: Partial<EditManifest> | null) {
  const { postId } = await p.seedPost(AYESHA);
  const videoId = await p.makeVideo(postId);
  const row = p.video(videoId)!;
  const e = p.extra(row);
  const bed = fixtureMusicLibrary().pick(videoId);
  e.transcript = structuredClone(fixed);
  e.final_path = `final/${row.brand_id}/${videoId}/runs/run_1.mp4`;
  e.edit_manifest =
    manifest === null
      ? null
      : {
          version: 1, raw_duration_s: 7.8, format: "talking", caption_style: "big_words",
          captions: groupPages(alignWords(AYESHA.displayText, fixed), "big_words"),
          broll: [], protected: { hook_end_s: 2.78, cta_start_s: 5.52 }, music: { bed_id: bed.id, gain_db: -22 },
          ai_label: true, watermark: false, not_applied: [], ...manifest,
        };
  await p.files.upload(e.final_path, FASTSTART_MP4, "video/mp4");
  row.status = "final_qa";
  p.v.posts[0].status = "final_qa";
  return videoId;
}

function deps(p: ReturnType<typeof memoryPipeline>, over: Partial<TechnicalGateDeps> = {}): TechnicalGateDeps {
  return { store: p.store, files: p.files, ffmpeg: fakeFfmpeg(), probeJson: async () => probe(), music: fixtureMusicLibrary(), ...over };
}

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network is not allowed in tests"));
  for (const name of ["MOCK_HEYGEN", "MOCK_STT", "MOCK_CLAUDE", "MOCK_PEXELS"]) vi.stubEnv(name, "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Gate 4 runner", () => {
  it("a good edit passes: one technical qa_reports row (score = integrated LUFS); video and post stay final_qa, ready for Gate 5", async () => {
    const p = memoryPipeline();
    const videoId = await editedVideo(p);
    const ffmpeg = fakeFfmpeg();
    const out = await runTechnicalGate(videoId, deps(p, { ffmpeg }));
    expect(out).toEqual({ status: "passed", videoId });
    expect(p.reports).toEqual([
      { video_id: videoId, script_id: expect.any(String), gate: "technical", passed: true, score: -14.1, issues: [], auto_fix: null },
    ]);
    expect(p.video(videoId)?.status).toBe("final_qa");
    expect(p.v.posts[0]).toMatchObject({ status: "final_qa", status_reason: null });
    // One pass over the final file + the voice and music stems (the same chain as the edit, one side each).
    expect(ffmpeg.calls).toHaveLength(3);
  });

  it("forced failure (a 25 fps file): rebuild the edit once, then the team queue; never the customer, never counted", async () => {
    const p = memoryPipeline();
    const videoId = await editedVideo(p);
    const bad = deps(p, { probeJson: async () => probe("25/1") });

    const first = await runTechnicalGate(videoId, bad);
    expect(first.status).toBe("rebuild");
    expect(p.reports[0]).toMatchObject({ gate: "technical", passed: false, auto_fix: null });
    expect(p.reports[0].issues).toEqual([expect.objectContaining({ code: "format", detail: expect.stringContaining("25 fps") })]);
    expect(p.video(videoId)?.status).toBe("audio_qa"); // back in the edit queue (start_edit accepts audio_qa)
    expect(p.v.posts[0].status).toBe("editing");

    // The rebuilt edit lands in final_qa again, and is still 25 fps.
    p.video(videoId)!.status = "final_qa";
    const second = await runTechnicalGate(videoId, bad);
    expect(second.status).toBe("team_review");
    expect(p.reports[1]).toMatchObject({ passed: false, auto_fix: "Rebuilt the edit once." });
    expect(p.video(videoId)).toMatchObject({ status: "team_review", counts_toward_plan: false });
    expect(p.v.posts[0].status).toBe("team_review");
    expect(p.v.posts[0].status_reason).toMatch(/^Technical check failed after one rebuild: Wrong format: 25 fps/);
  });

  it("an edit without a manifest (made before p5-a2) is rebuilt", async () => {
    const p = memoryPipeline();
    const videoId = await editedVideo(p, null);
    expect((await runTechnicalGate(videoId, deps(p))).status).toBe("rebuild");
    expect(p.reports[0].issues.map((i) => i.code)).toEqual(["no_manifest"]);
  });

  it("too quiet: the measured number is in the issue", async () => {
    const p = memoryPipeline();
    const videoId = await editedVideo(p);
    const ffmpeg = fakeFfmpeg(summary(-19.5, -6));
    await runTechnicalGate(videoId, deps(p, { ffmpeg }));
    expect(p.reports[0].issues.map((i) => [i.code, i.detail])).toEqual([["loudness", "-19.5 LUFS (want -14 ±1.5)."]]);
  });

  it("only a final_qa post video is checked", async () => {
    const p = memoryPipeline();
    const videoId = await editedVideo(p);
    p.video(videoId)!.status = "editing";
    expect((await runTechnicalGate(videoId, deps(p))).status).toBe("skipped");
    expect(p.reports).toEqual([]);
  });
});
