import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runClaudeTask, type ClaudeContext, type ClaudeTaskName } from "@/lib/claude";
import { captionFontsDir, runEditJob, type FfmpegRunner } from "@/lib/edit-flow";
import { fixtureMusicLibrary } from "@/lib/music";
import type { AudioGateDeps, AudioMeasure } from "@/lib/qa/audio-gate";
import {
  afterEdit,
  afterEditTask,
  afterPoll,
  afterRender,
  editJobFor,
  GATE_CRASH_REASONS,
  gateCrashed,
  RESYNC_TEAM_REASON,
  resyncAfterEdit,
} from "@/lib/qa/pipeline";
import type { TechnicalGateDeps } from "@/lib/qa/technical-gate";
import { memoryPipeline } from "@/tests/helpers/pipeline-memory";

// The QA pipeline with mocks only (QA-SPEC "Pipeline" test): render (MOCK_HEYGEN path + spend guard)
// → Gate 3 (MOCK_STT, MOCK_CLAUDE) → edit (lib/edit-flow.ts with a fake ffmpeg) → Gate 4 (fake
// ffprobe/ffmpeg output) → ready for Gate 5. Plus a forced failure at Gate 3 and at Gate 4: both end
// in the team queue, never with the customer, never counted. The real-ffmpeg runs are in tests/integration.

const AYESHA = {
  displayText: "Hi, I'm Ayesha from Bright Smile Dental. Brush twice a day and floss once. Book your free check-up today.",
  hook: "Hi, I'm Ayesha from Bright Smile Dental.",
  cta: "Book your free check-up today.",
};
const SAMEER = { ...AYESHA, displayText: AYESHA.displayText.replace("Ayesha", "Sameer"), hook: AYESHA.hook.replace("Ayesha", "Sameer") };

const box = (type: string, size: number) => {
  const b = Buffer.alloc(size);
  b.writeUInt32BE(size);
  b.write(type, 4, "ascii");
  return b;
};
const FASTSTART_MP4 = Buffer.concat([box("ftyp", 24), box("moov", 32), box("mdat", 64)]);
const PASS1 = `{\n\t"input_i" : "-19.43",\n\t"input_tp" : "-6.02",\n\t"input_lra" : "3.10",\n\t"input_thresh" : "-29.61",\n\t"target_offset" : "0.05"\n}\n`;
const summary = (i: number, tp: number) => `Summary:\n  Integrated loudness:\n    I:  ${i} LUFS\n  True peak:\n    Peak:  ${tp} dBFS\n`;
const probe = (fps: string) =>
  JSON.stringify({
    streams: [
      { codec_type: "video", codec_name: "h264", width: 1080, height: 1920, pix_fmt: "yuv420p", avg_frame_rate: fps },
      { codec_type: "audio", codec_name: "aac", sample_rate: "48000" },
    ],
    format: { duration: "7.800000", size: "3100000" },
  });

/** One fake ffmpeg for the editor (loudness pass 1 + final encode) and Gate 4 (final pass + 2 stems). */
const fakeFfmpeg: FfmpegRunner = async (args) => {
  const graph = args[args.indexOf("-filter_complex") + 1] ?? "";
  if (graph.includes("blackdetect")) return { stderr: summary(-14.1, -1.6) };
  if (graph.includes("[music]anullsink")) return { stderr: summary(-16.2, -3) };
  if (graph.includes("[voice]anullsink")) return { stderr: summary(-44.5, -30) };
  if (graph.includes("print_format=json")) return { stderr: PASS1 };
  if (graph.includes("subtitles=")) {
    await writeFile(args.at(-1)!, FASTSTART_MP4);
    return { stderr: "" };
  }
  throw new Error(`unexpected ffmpeg call ${args.join(" ")}`);
};

const run = <T extends ClaudeTaskName>(task: T, ctx: ClaudeContext<T>) => runClaudeTask(task, ctx, { logUsage: async () => {} });
const healthy: AudioMeasure = { durationS: 7.6, silences: [], astats: { peakDb: -3.2, peakCount: 2 } };
let tmpRoot: string;

function pipeline(opts: Parameters<typeof memoryPipeline>[0] = {}) {
  const p = memoryPipeline(opts);
  const gate3: AudioGateDeps = { store: p.store, files: p.files, run, render: p.render, measureAudio: async () => healthy, tmpRoot };
  const gate4 = (fps = "30/1"): TechnicalGateDeps => ({
    store: p.store, files: p.files, ffmpeg: fakeFfmpeg, probeJson: async () => probe(fps), music: fixtureMusicLibrary(), tmpRoot,
  });
  let editRuns = 0;
  /** The edit-video task's work: lib/edit-flow.ts on the same rows (fake ffmpeg, mock music/b-roll). */
  const edit = async (job: Parameters<typeof runEditJob>[0]) =>
    runEditJob(job, {
      store: p.editStore, files: p.files, ffmpeg: fakeFfmpeg, tmpRoot, fontsDir: captionFontsDir(), runToken: `run_${++editRuns}`,
      music: fixtureMusicLibrary(), probeDurationS: async () => 7.8,
    });
  return { p, gate3, gate4, edit };
}

beforeEach(async () => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network is not allowed in tests"));
  for (const name of ["MOCK_HEYGEN", "MOCK_STT", "MOCK_CLAUDE", "MOCK_PEXELS"]) vi.stubEnv(name, "");
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "qa-pipeline-"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("the edit payload comes from the rows (posts.format, scripts.hook/cta/broll_keywords/edit_plan, videos.ai_label/watermark)", () => {
  it("editJobFor", async () => {
    const { p } = pipeline();
    const { postId } = await p.seedPost({ ...AYESHA, format: "story", brollKeywords: ["toothbrush"], editPlan: { broll_moments: [], emphasis_words: ["free"] } });
    const videoId = await p.makeVideo(postId);
    p.extra(p.video(videoId)!).watermark = true;
    const ctx = (await p.store.getGateContext(videoId))!;
    expect(editJobFor(ctx)).toEqual({
      videoId, rawPath: p.video(videoId)!.raw_path, displayText: AYESHA.displayText, editPlan: { broll_moments: [], emphasis_words: ["free"] },
      hook: AYESHA.hook, cta: AYESHA.cta, format: "story", brollKeywords: ["toothbrush"], aiLabel: true, watermark: true,
    });
  });
});

describe("render → Gate 3 → edit → Gate 4 → ready for Gate 5", () => {
  it("the happy path (and the mispronounced-name path: Gate 3 fix → one re-render → on through the edit)", async () => {
    const { p, gate3, gate4, edit } = pipeline();
    const { postId } = await p.seedPost(AYESHA);
    const first = await p.makeVideo(postId);

    // Gate 3 catches "asia" → respelling + one re-render; the poll for the new video comes next.
    const r1 = await afterRender(first, gate3);
    expect(r1.outcome.status).toBe("rerendering");
    const second = (r1.outcome as { videoId: string }).videoId;
    expect(r1.next).toEqual({ taskId: "poll-render", payload: { videoId: second }, key: `poll-render-${second}` });
    await p.finishRender(second);
    expect(afterPoll({ done: true, status: "rendered" }, { id: second, kind: "post" })).toEqual({
      taskId: "audio-qa", payload: { videoId: second }, key: `audio-qa-${second}`,
    });

    // Gate 3 passes → the edit, which REUSES the transcript Gate 3 saved (no second speech-to-text).
    const r2 = await afterRender(second, gate3);
    expect(r2.outcome.status).toBe("passed");
    expect(r2.next).toMatchObject({ taskId: "edit-video", key: `edit-${second}-1`, payload: { videoId: second, hook: AYESHA.hook, aiLabel: true } });
    const transcriptBefore = structuredClone(p.extra(p.video(second)!).transcript);
    const edited = await edit((r2.next as { payload: Parameters<typeof runEditJob>[0] }).payload);
    expect(edited.status).toBe("edited");
    expect(p.extra(p.video(second)!).transcript).toEqual(transcriptBefore);
    expect(afterEditTask(edited, second, "run_1")).toEqual({ taskId: "technical-qa", payload: { videoId: second }, key: `technical-qa-${second}-run_1` });

    // Gate 4 passes → Gate 5 next (p5-b2), one key per edit run.
    const r3 = await afterEdit(second, gate4());
    expect(r3.outcome.status).toBe("passed");
    expect(r3.next).toEqual({ taskId: "visual-qa", payload: { videoId: second }, key: `visual-qa-${second}-run_1` });
    expect(p.video(second)).toMatchObject({ status: "final_qa", counts_toward_plan: false });
    expect(p.v.posts[0]).toMatchObject({ status: "final_qa", status_reason: null });
    expect(p.reports.map((r) => [r.video_id, r.gate, r.passed])).toEqual([
      [first, "audio", false],
      [second, "audio", true],
      [second, "technical", true],
    ]);
  });
});

describe("forced failures end in the team queue, never with the customer, never counted", () => {
  it("Gate 3 double fail: re-render once, then team_review; no edit", async () => {
    const { p, gate3 } = pipeline({ personName: "Sameer Ali" });
    const { postId } = await p.seedPost(SAMEER);
    const first = await p.makeVideo(postId);
    const r1 = await afterRender(first, gate3);
    const second = (r1.outcome as { videoId: string }).videoId;
    await p.finishRender(second);
    const r2 = await afterRender(second, gate3);
    expect(r2.outcome.status).toBe("team_review");
    expect(r2.next).toBeNull();
    expect(p.v.posts[0].status).toBe("team_review");
    expect(p.v.videos.map((v) => [v.status, v.counts_toward_plan])).toEqual([
      ["failed", false],
      ["team_review", false],
    ]);
  });

  it("Gate 4 double fail (25 fps): one rebuild of the edit, then team_review", async () => {
    const { p, gate3, gate4, edit } = pipeline();
    const { postId } = await p.seedPost({ ...AYESHA, dictionary: [{ written: "Ayesha", say_as: "Aa-ee-sha", status: "approved" }] });
    const videoId = await p.makeVideo(postId);
    const r1 = await afterRender(videoId, gate3);
    expect(r1.outcome.status).toBe("passed");
    await edit((r1.next as { payload: Parameters<typeof runEditJob>[0] }).payload);

    const bad = await afterEdit(videoId, gate4("25/1"));
    expect(bad.outcome.status).toBe("rebuild");
    expect(bad.next).toMatchObject({ taskId: "edit-video", key: `edit-${videoId}-rebuild-1`, payload: { videoId } });
    const rebuilt = await edit((bad.next as { payload: Parameters<typeof runEditJob>[0] }).payload);
    expect(rebuilt.status).toBe("edited");

    const again = await afterEdit(videoId, gate4("25/1"));
    expect(again.outcome.status).toBe("team_review");
    expect(again.next).toBeNull();
    expect(p.video(videoId)).toMatchObject({ status: "team_review", counts_toward_plan: false });
    expect(p.v.posts[0].status).toBe("team_review");
    expect(p.reports.filter((r) => r.gate === "technical").map((r) => [r.passed, r.auto_fix])).toEqual([
      [false, null],
      [false, "Rebuilt the edit once."],
    ]);
  });

  it("p5-b1 (QA SF1): Gate 3 crashes (speech-to-text throws, retries exhausted) → the failure hook moves video + post to team_review; twice changes nothing more", async () => {
    const { p, gate3 } = pipeline();
    const { postId } = await p.seedPost(AYESHA);
    const videoId = await p.makeVideo(postId);
    const broken = { transcribe: async () => { throw new Error("ENOENT: no such file tests/fixtures/stt/by-text.json"); } };
    await expect(afterRender(videoId, { ...gate3, stt: broken })).rejects.toThrow(/ENOENT/);
    expect(p.video(videoId)?.status).toBe("audio_qa"); // stuck without the hook

    expect(await gateCrashed("audio", videoId, new Error("ENOENT"), p.store)).toBe(true);
    expect(p.video(videoId)).toMatchObject({ status: "team_review", error: GATE_CRASH_REASONS.audio });
    expect(p.v.posts[0]).toMatchObject({ status: "team_review", status_reason: GATE_CRASH_REASONS.audio });

    // Safe to run more than once: the row has left audio_qa, so nothing moves (and the post is not touched).
    p.v.posts[0].status_reason = "the team is on it";
    expect(await gateCrashed("audio", videoId, new Error("again"), p.store)).toBe(false);
    expect(p.v.posts[0].status_reason).toBe("the team is on it");
  });

  it("p5-b1 (QA SF1): Gate 4 crashes → final_qa → team_review; a row that moved on (or the wrong gate) is never touched", async () => {
    const { p, gate3, gate4, edit } = pipeline();
    const { postId } = await p.seedPost({ ...AYESHA, dictionary: [{ written: "Ayesha", say_as: "Aa-ee-sha", status: "approved" }] });
    const videoId = await p.makeVideo(postId);
    const r1 = await afterRender(videoId, gate3);
    await edit((r1.next as { payload: Parameters<typeof runEditJob>[0] }).payload);
    expect(p.video(videoId)?.status).toBe("final_qa");
    const crashing: FfmpegRunner = async () => { throw new Error("ffmpeg was killed"); };
    await expect(afterEdit(videoId, { ...gate4(), ffmpeg: crashing })).rejects.toThrow(/killed/);
    expect(p.video(videoId)?.status).toBe("final_qa");

    // The audio hook only takes rows in audio_qa: a final_qa row is not its business.
    expect(await gateCrashed("audio", videoId, new Error("x"), p.store)).toBe(false);
    expect(p.video(videoId)?.status).toBe("final_qa");

    expect(await gateCrashed("technical", videoId, new Error("ffmpeg was killed"), p.store)).toBe(true);
    expect(p.video(videoId)).toMatchObject({ status: "team_review", error: GATE_CRASH_REASONS.technical });
    expect(p.v.posts[0]).toMatchObject({ status: "team_review", status_reason: GATE_CRASH_REASONS.technical });
    expect(await gateCrashed("technical", videoId, new Error("again"), p.store)).toBe(false);
  });

  it("p5-b1 (QA SF1): a crash for a video that does not exist changes nothing", async () => {
    const { p } = pipeline();
    expect(await gateCrashed("audio", "90000000-0000-4000-8000-00000000dead", new Error("x"), p.store)).toBe(false);
  });

  it("p5-b1 (Rowan 4): a post stuck in 'editing' after the edit was promoted is re-synced, and Gate 4 starts once (run twice)", async () => {
    const { p, gate3, edit } = pipeline();
    const { postId } = await p.seedPost({ ...AYESHA, dictionary: [{ written: "Ayesha", say_as: "Aa-ee-sha", status: "approved" }] });
    const videoId = await p.makeVideo(postId);
    const r1 = await afterRender(videoId, gate3);
    // The edit finished and was promoted, but the post update failed (afterPromotion only logs it).
    const realSet = p.editStore.setPostStatusForVideo;
    p.editStore.setPostStatusForVideo = async (id, status, reason) => {
      if (status !== "editing") throw new Error("database is busy");
      return realSet(id, status, reason);
    };
    expect((await edit((r1.next as { payload: Parameters<typeof runEditJob>[0] }).payload)).status).toBe("edited");
    expect(p.video(videoId)?.status).toBe("final_qa");
    expect(p.v.posts[0].status).toBe("editing"); // stuck

    // A starter that, like Trigger.dev's global idempotency keys, starts each key once.
    const started: string[] = [];
    const startOnce = (next: { key: string } | null) => {
      if (next && !started.includes(next.key)) started.push(next.key);
    };
    const first = await resyncAfterEdit(videoId, p.store);
    expect(first.moved).toBe(true);
    expect(p.v.posts[0]).toMatchObject({ status: "final_qa", status_reason: null });
    // Same key edit-video uses for this edit run (afterEditTask), so the two never both start Gate 4.
    expect(first.next).toEqual(afterEditTask({ status: "edited" }, videoId, "run_1"));
    startOnce(first.next);

    const second = await resyncAfterEdit(videoId, p.store);
    expect(second.moved).toBe(false);
    expect(second.next?.key).toBe(first.next?.key);
    startOnce(second.next);
    startOnce(afterEditTask({ status: "edited" }, videoId, "run_1"));
    expect(started).toEqual([`technical-qa-${videoId}-run_1`]);
    expect(p.v.posts[0]).toMatchObject({ status: "final_qa", status_reason: null });
  });

  it("p5-b1 (Rowan 4): re-sync leaves alone a post that is not stuck, a video with no final file, and a team_review edit starts no Gate 4", async () => {
    const { p, gate3, edit } = pipeline();
    const { postId } = await p.seedPost({ ...AYESHA, dictionary: [{ written: "Ayesha", say_as: "Aa-ee-sha", status: "approved" }] });
    const videoId = await p.makeVideo(postId);
    // Rendered, not edited: no final file → nothing.
    expect(await resyncAfterEdit(videoId, p.store)).toEqual({ moved: false, next: null });
    const r1 = await afterRender(videoId, gate3);
    await edit((r1.next as { payload: Parameters<typeof runEditJob>[0] }).payload);
    // Post already final_qa (the normal path): no move.
    expect((await resyncAfterEdit(videoId, p.store)).moved).toBe(false);
    // The edit went to the team (video team_review, file kept) but the post stayed in editing.
    p.video(videoId)!.status = "team_review";
    p.v.posts[0].status = "editing";
    const out = await resyncAfterEdit(videoId, p.store);
    expect(out).toEqual({ moved: true, next: null });
    expect(p.v.posts[0]).toMatchObject({ status: "team_review", status_reason: RESYNC_TEAM_REASON });
  });

  it("p5-b1 (QA NICE 6): Gate 3 → team, but the video moved on meanwhile: the post is NOT touched", async () => {
    const { p, gate3 } = pipeline({ maxSeconds: 5 }); // too long for the plan → straight to the team
    const { postId } = await p.seedPost({ ...AYESHA, dictionary: [{ written: "Ayesha", say_as: "Aa-ee-sha", status: "approved" }] });
    const videoId = await p.makeVideo(postId);
    const realMove = p.store.moveVideo;
    p.store.moveVideo = async (id, to, from, error) => (to === "team_review" ? false : realMove(id, to, from, error));
    const out = await afterRender(videoId, gate3);
    expect(out.outcome.status).toBe("skipped");
    expect(p.v.posts[0].status).toBe("audio_qa");
  });

  it("p5-b1 (QA NICE 6): Gate 4 → team, but the video moved on meanwhile: the post is NOT touched", async () => {
    const { p, gate3, gate4, edit } = pipeline();
    const { postId } = await p.seedPost({ ...AYESHA, dictionary: [{ written: "Ayesha", say_as: "Aa-ee-sha", status: "approved" }] });
    const videoId = await p.makeVideo(postId);
    const r1 = await afterRender(videoId, gate3);
    await edit((r1.next as { payload: Parameters<typeof runEditJob>[0] }).payload);
    const realMove = p.store.moveVideo;
    // No rebuild possible either (both moves refused): the team route must not move the post.
    p.store.moveVideo = async () => false;
    const out = await afterEdit(videoId, gate4("25/1"));
    expect(out.outcome.status).toBe("skipped");
    expect(p.v.posts[0].status).toBe("final_qa");
    p.store.moveVideo = realMove;
  });

  it("a finished likeness test or a failed poll starts nothing", () => {
    expect(afterPoll({ done: true, status: "rendered" }, { id: "v", kind: "likeness_test" })).toBeNull();
    expect(afterPoll({ done: true, status: "failed" }, { id: "v", kind: "post" })).toBeNull();
    expect(afterPoll({ done: false, status: "rendering" }, { id: "v", kind: "post" })).toBeNull();
    expect(afterEditTask({ status: "needs_team" }, "v", "run")).toBeNull();
  });
});
