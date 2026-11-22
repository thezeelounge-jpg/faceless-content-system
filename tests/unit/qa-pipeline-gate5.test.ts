import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runClaudeTask, type ClaudeContext, type ClaudeTaskName } from "@/lib/claude";
import { captionFontsDir, runEditJob, type EditJob, type FfmpegRunner } from "@/lib/edit-flow";
import { fixtureMusicLibrary } from "@/lib/music";
import { PlainError } from "@/lib/plain-error";
import type { AudioMeasure } from "@/lib/qa/audio-gate";
import { editManifestSchema } from "@/lib/qa/edit-manifest";
import {
  afterEdit,
  afterEditTask,
  afterPoll,
  afterRender,
  afterVisual,
  editJobFor,
  GATE_CRASH_REASONS,
  gateCrashed,
  type NextTask,
} from "@/lib/qa/pipeline";
import { HUMAN_REVIEW_TEXT } from "@/lib/qa/visual-checks";
import type { VisualGateDeps } from "@/lib/qa/visual-gate";
import { VISUAL_FIXTURE_TEXTS } from "@/lib/qa/visual-mock";
import { memoryPipeline } from "@/tests/helpers/pipeline-memory";
import { fakeFrames } from "@/tests/helpers/visual-frames";

// p5-b2: the whole mocked video pipeline, driven the way Trigger.dev would run it (each `next` task
// started once per global idempotency key): render → Gate 3 → edit → Gate 4 → Gate 5 → QA queue or
// ready. MOCK_HEYGEN, MOCK_STT, MOCK_CLAUDE, MOCK_PEXELS; a fake ffmpeg for the editor and Gate 4;
// Gate 5 frames drawn the way the edit's manifest says the editor drew them. Includes the Phase 5
// Done-when cases for Gate 5, the human-review rule and the usage rule (only the ONE delivered video
// per post counts). Gate 1 and Gate 2 forced failures: tests/unit/script-gate.test.ts and
// tests/unit/pronunciation-prep.test.ts (the script pipeline, before any render).

const HOOK = "Hi, I'm Ayesha from Bright Smile Dental.";
const CTA = "Book your free check-up today.";
const GOOD = "Hi, I'm Ayesha from Bright Smile Dental. Brush twice a day and floss once. Book your free check-up today.";
const SAMEER = GOOD.replace("Ayesha", "Sameer");

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

beforeEach(async () => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network is not allowed in tests"));
  for (const name of ["MOCK_HEYGEN", "MOCK_STT", "MOCK_CLAUDE", "MOCK_PEXELS"]) vi.stubEnv(name, "");
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "qa-pipeline-g5-"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

type Opts = {
  managed?: boolean;
  established?: boolean;
  fps?: string;
  hear?: "right" | "stt";
  /** Gate 5's renderer (default: the normal renderVideo with the mock HeyGen client). */
  render5?: VisualGateDeps["render"];
  /** The twin's person (a Gate 3 key term). Default Ayesha Khan. */
  personName?: string;
};

/** One brand's pipeline + a driver that runs `next` tasks like Trigger.dev (each key once). */
function world(opts: Opts = {}) {
  const p = memoryPipeline({ personName: opts.personName });
  p.brandInfo.is_managed = opts.managed ?? false;
  if (opts.established ?? true) {
    const real = p.store.countBrandPostsPassed;
    p.store.countBrandPostsPassed = async (...args) => 5 + (await real(...args));
  }
  let editRuns = 0;
  const editPayloads: EditJob[] = [];
  const gate5 = (): VisualGateDeps => ({
    store: p.store, files: p.files, run, render: opts.render5 ?? p.render, tmpRoot, sample: () => false,
    frames: async (_file, manifest) => fakeFrames(manifest, { aiLabel: manifest.ai_label, watermark: manifest.watermark }),
  });
  const texts = new Map<string, string>();

  async function drive(first: NextTask): Promise<string[]> {
    const started = new Set<string>();
    const log: string[] = [];
    const queue: (NextTask | null)[] = [first];
    while (queue.length > 0) {
      const next = queue.shift();
      if (!next || started.has(next.key)) continue;
      started.add(next.key);
      log.push(next.taskId);
      const id = next.payload.videoId;
      switch (next.taskId) {
        case "poll-render": {
          await p.finishRender(id);
          queue.push(afterPoll({ done: true, status: "rendered" }, { id, kind: "post" }));
          break;
        }
        case "audio-qa": {
          // Speech-to-text heard the script exactly (or, with hear: "stt", the keyed MOCK_STT fixtures).
          const row = p.video(id)!;
          const ctx = (await p.store.getGateContext(id))!;
          if ((opts.hear ?? "right") === "right" && !p.extra(row).transcript) heardRight(p, id, texts.get(ctx.script.id) ?? ctx.script.display_text);
          queue.push((await afterRender(id, { store: p.store, files: p.files, run, render: p.render, measureAudio: async () => healthy, tmpRoot })).next);
          break;
        }
        case "edit-video": {
          editPayloads.push(next.payload);
          const runToken = `run_${++editRuns}`;
          const out = await runEditJob(next.payload, {
            store: p.editStore, files: p.files, ffmpeg: fakeFfmpeg, tmpRoot, fontsDir: captionFontsDir(), runToken,
            music: fixtureMusicLibrary(), probeDurationS: async () => 7.8,
          });
          queue.push(afterEditTask(out, id, runToken));
          break;
        }
        case "technical-qa":
          queue.push(
            (await afterEdit(id, { store: p.store, files: p.files, ffmpeg: fakeFfmpeg, probeJson: async () => probe(opts.fps ?? "30/1"), music: fixtureMusicLibrary(), tmpRoot }))
              .next,
          );
          break;
        case "visual-qa":
          queue.push((await afterVisual(id, gate5())).next);
          break;
        case "render-video":
          break; // waits for a free render slot (trigger/render-video.ts); recorded, not run here

        default:
          throw new Error(`unexpected task ${(next as NextTask).taskId}`);
      }
    }
    return log;
  }

  /** A post with this script, rendered (mock HeyGen, spend guard), then the whole pipeline. */
  async function post(text: string, n = 0) {
    const ids = n === 0 ? {} : { postId: `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`, scriptId: `30000000-0000-4000-8000-${String(n).padStart(12, "0")}` };
    const { postId, scriptId } = await p.seedPost({ displayText: text, hook: HOOK, cta: CTA, ...ids });
    texts.set(scriptId, text);
    const videoId = await p.makeVideo(postId);
    const log = await drive(afterPoll({ done: true, status: "rendered" }, { id: videoId, kind: "post" })!);
    return { postId, scriptId, videoId, log };
  }
  const postRow = (postId: string) => p.v.posts.find((x) => x.id === postId)!;
  const videosOf = (postId: string) => p.v.videos.filter((x) => p.extra(x).post_id === postId);
  /** How many videos of this post count toward the plan (the usage rule: 1 when delivered, else 0). */
  const counted = (postId: string) => videosOf(postId).filter((x) => x.counts_toward_plan).length;
  return { p, drive, post, postRow, videosOf, counted, editPayloads };
}

function heardRight(p: ReturnType<typeof memoryPipeline>, videoId: string, text: string) {
  p.extra(p.video(videoId)!).transcript = {
    language: "en", duration_s: 7.6,
    words: text.split(" ").map((w, i) => ({ text: w, start_s: Math.round((0.2 + i * 0.38) * 1000) / 1000, end_s: Math.round((0.5 + i * 0.38) * 1000) / 1000 })),
  };
}

describe("p5-b2: render → Gate 3 → edit → Gate 4 → Gate 5 → ready (mocks only)", () => {
  it("the happy path: every gate passes once, the video is delivered and is the post's ONE counted video", async () => {
    const w = world();
    const { postId, videoId, log } = await w.post(GOOD);
    expect(log).toEqual(["audio-qa", "edit-video", "technical-qa", "visual-qa"]);
    expect(w.p.video(videoId)).toMatchObject({ status: "ready", counts_toward_plan: true });
    expect(w.postRow(postId)).toMatchObject({ status: "ready", status_reason: null });
    expect(w.p.reports.map((r) => [r.gate, r.passed])).toEqual([["audio", true], ["technical", true], ["visual", true]]);
    expect(w.counted(postId)).toBe(1);
  });

  it("Gate 4 passes → Gate 5 is next with one key per edit run (a retry never starts it twice)", async () => {
    const w = world();
    const { postId } = await w.p.seedPost({ displayText: GOOD, hook: HOOK, cta: CTA });
    const videoId = await w.p.makeVideo(postId);
    heardRight(w.p, videoId, GOOD);
    const log = await w.drive({ taskId: "audio-qa", payload: { videoId }, key: `audio-qa-${videoId}` });
    expect(log.filter((t) => t === "visual-qa")).toHaveLength(1);
  });
});

describe("Phase 5 Done-when (Gate 5)", () => {
  it("(a) a video with captions over the mouth fails Gate 5 and is fixed automatically: report #1 failed (captions over the mouth), ONE re-edit with the lower caption style, report #2 passed, then the QA queue (auto-fixed); not counted until delivered", async () => {
    const w = world();
    const { postId, videoId, log } = await w.post(VISUAL_FIXTURE_TEXTS["captions-over-mouth"]);
    expect(log).toEqual(["audio-qa", "edit-video", "technical-qa", "visual-qa", "edit-video", "technical-qa", "visual-qa"]);
    const visual = w.p.reports.filter((r) => r.gate === "visual");
    expect(visual.map((r) => r.passed)).toEqual([false, true]);
    expect(visual[0].issues.filter((i) => i.severity === "hard").map((i) => i.code)).toEqual(["captions_over_face"]);
    expect(visual[0].issues[0].at_seconds).toEqual(expect.any(Number));
    expect(visual[1].auto_fix).toMatch(/re-edited once: captions moved lower and smaller \(big_words → small_box\)/);
    // Exactly one re-edit, with the fixed caption position; the second edit's manifest says so.
    expect(w.editPayloads.map((j) => j.captionStyle ?? "big_words")).toEqual(["big_words", "small_box"]);
    expect(editManifestSchema.parse(w.p.extra(w.p.video(videoId)!).edit_manifest).caption_style).toBe("small_box");
    // One video row (no re-render). p5-b4 (QA-SPEC Gate 6): it passed only after an automatic fix, so a
    // person watches it first: QA queue with the auto-fixed reason, NOT counted until delivered
    // (Gate 6 approve = rpc review_queued_video, tests/db/rls.test.ts p5-b4 usage walk).
    expect(w.videosOf(postId)).toHaveLength(1);
    expect(w.p.video(videoId)).toMatchObject({ status: "team_review", counts_toward_plan: false });
    expect(w.postRow(postId)).toMatchObject({ status: "team_review", status_reason: HUMAN_REVIEW_TEXT.auto_fixed });
    expect(w.counted(postId)).toBe(0);
  });

  it("(b) a forced double failure lands in the QA queue, not with the customer, and doesn't count against the plan", async () => {
    const w = world();
    const { postId, videoId, log } = await w.post(VISUAL_FIXTURE_TEXTS["face-glitch"]);
    // Gate 5 fails → ONE re-render (our cost) → the new video goes through Gates 3, 4, 5 → fails again → team.
    expect(log).toEqual([
      "audio-qa", "edit-video", "technical-qa", "visual-qa",
      "poll-render", "audio-qa", "edit-video", "technical-qa", "visual-qa",
    ]);
    const [first, second] = w.videosOf(postId);
    expect(first.id).toBe(videoId);
    expect(first).toMatchObject({ status: "failed", counts_toward_plan: false });
    expect(second).toMatchObject({ status: "team_review", attempt: 2, counts_toward_plan: false });
    expect(w.postRow(postId).status).toBe("team_review"); // the QA queue; the customer sees "Checking quality"
    expect(w.postRow(postId).status_reason).toMatch(/^Visual check failed after one automatic fix: /);
    expect(w.p.reports.filter((r) => r.gate === "visual").map((r) => [r.video_id, r.passed, r.auto_fix])).toEqual([
      [first.id, false, null],
      [second.id, false, expect.stringMatching(/^Gate 5: re-rendered once on the same engine \(face_glitch, mouth_blur, realism\)\.$/)],
    ]);
    expect(w.p.v.videos.some((x) => x.status === "ready")).toBe(false);
    expect(w.counted(postId)).toBe(0);
    expect(w.p.spend.rows.every((r) => r.mock === true)).toBe(true);
  });

  it("(c) the first 5 videos of a new brand always go to the QA queue, even when every gate passes; the 6th goes straight to ready", async () => {
    const w = world({ established: false });
    const outcomes: [string, string | null, number][] = [];
    for (let n = 1; n <= 6; n++) {
      const { postId } = await w.post(GOOD, n);
      outcomes.push([w.postRow(postId).status, w.postRow(postId).status_reason, w.counted(postId)]);
    }
    const queued: [string, string | null, number] = ["team_review", HUMAN_REVIEW_TEXT.first_videos, 0];
    expect(outcomes).toEqual([queued, queued, queued, queued, queued, ["ready", null, 1]]);
    // All six passed every gate.
    expect(w.p.reports.every((r) => r.passed)).toBe(true);
    expect(w.p.reports.filter((r) => r.gate === "visual")).toHaveLength(6);
  });
});

describe("p5-b2: a forced failure at every video gate ends in the right status and qa_reports rows", () => {
  it("Gate 3 double failure (name misheard twice, MOCK_STT) → team_review; no edit, no Gate 4/5, nothing counted", async () => {
    const w = world({ hear: "stt", personName: "Sameer Ali" });
    const p = w.p;
    const { postId } = await p.seedPost({ displayText: SAMEER, hook: HOOK.replace("Ayesha", "Sameer"), cta: CTA });
    const videoId = await p.makeVideo(postId);
    const log = await w.drive({ taskId: "audio-qa", payload: { videoId }, key: `audio-qa-${videoId}` });
    expect(log).toEqual(["audio-qa", "poll-render", "audio-qa"]);
    expect(p.reports.map((r) => [r.gate, r.passed])).toEqual([["audio", false], ["audio", false]]);
    expect(w.postRow(postId).status).toBe("team_review");
    expect(w.counted(postId)).toBe(0);
  });

  it("Gate 4 double failure (25 fps) → one rebuild → team_review; Gate 5 never runs; nothing counted", async () => {
    const w = world({ fps: "25/1" });
    const { postId, log } = await w.post(GOOD);
    expect(log).toEqual(["audio-qa", "edit-video", "technical-qa", "edit-video", "technical-qa"]);
    expect(w.p.reports.map((r) => [r.gate, r.passed])).toEqual([["audio", true], ["technical", false], ["technical", false]]);
    expect(w.postRow(postId).status).toBe("team_review");
    expect(w.counted(postId)).toBe(0);
  });

  it("Gate 5 failure a fix can't help (face below the face-zone estimate) → team_review at once with the team reason", async () => {
    const w = world();
    const { postId, log } = await w.post(VISUAL_FIXTURE_TEXTS["face-too-low"]);
    expect(log).toEqual(["audio-qa", "edit-video", "technical-qa", "visual-qa"]);
    expect(w.p.reports.at(-1)).toMatchObject({ gate: "visual", passed: false });
    expect(w.postRow(postId)).toMatchObject({ status: "team_review" });
    expect(w.postRow(postId).status_reason).toMatch(/face-zone estimate is wrong/);
    expect(w.counted(postId)).toBe(0);
  });

  it("Gate 5 b-roll stray text → one re-edit with that clip swapped out (the rejected clip never comes back)", async () => {
    const w = world();
    const p = w.p;
    const text = VISUAL_FIXTURE_TEXTS["broll-logo"];
    const { postId } = await p.seedPost({
      displayText: text, hook: HOOK, cta: CTA, brollKeywords: ["coffee shop"],
      editPlan: { broll_moments: [{ at_words: "Visit us twice", keyword: "coffee shop" }], emphasis_words: [] },
    });
    const videoId = await p.makeVideo(postId);
    const log = await w.drive({ taskId: "audio-qa", payload: { videoId }, key: `audio-qa-${videoId}` });
    expect(log.slice(0, 5)).toEqual(["audio-qa", "edit-video", "technical-qa", "visual-qa", "edit-video"]);
    const firstClips = editManifestSchema.parse(p.extra(p.video(videoId)!).edit_manifest);
    expect(w.editPayloads[1].avoidBrollClips?.length).toBe(1);
    expect(firstClips.broll.map((c) => c.clip)).not.toContain(w.editPayloads[1].avoidBrollClips![0]);
    expect(firstClips.avoid_clips).toEqual(w.editPayloads[1].avoidBrollClips);
  });
});

describe("p5-b2: the usage rule across Gates 3, 4, 5 and the queue", () => {
  it("Gate 3 re-render then passes: the failed first render never counts; the auto-fixed re-render waits in the QA queue, not counted until delivered", async () => {
    const w = world({ hear: "stt" });
    const p = w.p;
    const { postId } = await p.seedPost({ displayText: GOOD, hook: HOOK, cta: CTA });
    const videoId = await p.makeVideo(postId);
    const log = await w.drive({ taskId: "audio-qa", payload: { videoId }, key: `audio-qa-${videoId}` });
    expect(log).toEqual(["audio-qa", "poll-render", "audio-qa", "edit-video", "technical-qa", "visual-qa"]);
    expect(w.videosOf(postId).map((x) => [x.attempt, x.status, x.counts_toward_plan])).toEqual([
      [1, "failed", false],
      [2, "team_review", false],
    ]);
    expect(w.postRow(postId)).toMatchObject({ status: "team_review", status_reason: HUMAN_REVIEW_TEXT.auto_fixed });
    expect(w.counted(postId)).toBe(0);
  });

  it("Gate 4 rebuild then passes → QA queue (auto-fixed), not counted yet; a QA-queue video (first 5 / managed) → not counted (yet)", async () => {
    // A rebuild: the first technical check fails, the rebuilt edit passes.
    const w = world();
    let probes = 0;
    const p = w.p;
    const { postId } = await p.seedPost({ displayText: GOOD, hook: HOOK, cta: CTA });
    const videoId = await p.makeVideo(postId);
    heardRight(p, videoId, GOOD);
    // Drive by hand: Gate 3 → edit → Gate 4 (25 fps, fails) → rebuild → Gate 4 (30 fps) → Gate 5.
    const g3 = await afterRender(videoId, { store: p.store, files: p.files, run, render: p.render, measureAudio: async () => healthy, tmpRoot });
    const editOnce = async (job: EditJob, runToken: string) =>
      runEditJob(job, { store: p.editStore, files: p.files, ffmpeg: fakeFfmpeg, tmpRoot, fontsDir: captionFontsDir(), runToken, music: fixtureMusicLibrary(), probeDurationS: async () => 7.8 });
    await editOnce((g3.next as { payload: EditJob }).payload, "run_1");
    const g4deps = () => ({ store: p.store, files: p.files, ffmpeg: fakeFfmpeg, probeJson: async () => probe(++probes === 1 ? "25/1" : "30/1"), music: fixtureMusicLibrary(), tmpRoot });
    const bad = await afterEdit(videoId, g4deps());
    expect(bad.outcome.status).toBe("rebuild");
    await editOnce((bad.next as { payload: EditJob }).payload, "run_2");
    const good = await afterEdit(videoId, g4deps());
    expect(good.next).toEqual({ taskId: "visual-qa", payload: { videoId }, key: `visual-qa-${videoId}-run_2` });
    const g5 = await afterVisual(videoId, {
      store: p.store, files: p.files, run, render: p.render, tmpRoot, sample: () => false,
      frames: async (_f, m) => fakeFrames(m, { aiLabel: m.ai_label, watermark: m.watermark }),
    });
    expect(g5.outcome).toMatchObject({ status: "queued", reasons: ["auto_fixed"] });
    expect(w.counted(postId)).toBe(0);

    // The queue path: a managed brand's video passes everything and waits for the team, uncounted.
    const m = world({ managed: true });
    const queued = await m.post(GOOD);
    expect(m.postRow(queued.postId)).toMatchObject({ status: "team_review", status_reason: HUMAN_REVIEW_TEXT.managed });
    expect(m.counted(queued.postId)).toBe(0);
  });
});

describe("p5-b2: orchestrator details", () => {
  it("a re-edit payload comes from the rows + Gate 5's fix; a later rebuild keeps the fixed caption style and avoided clips (from the manifest)", async () => {
    const w = world();
    const { videoId } = await w.post(VISUAL_FIXTURE_TEXTS["captions-over-mouth"]);
    const ctx = (await w.p.store.getGateContext(videoId))!;
    expect(editJobFor(ctx)).toMatchObject({ captionStyle: "small_box", avoidBrollClips: [] });
  });

  it("a crashed visual-qa run (failed for good) moves a final_qa video + post to team_review; twice changes nothing more", async () => {
    const w = world();
    const p = w.p;
    const { postId } = await p.seedPost({ displayText: GOOD, hook: HOOK, cta: CTA });
    const videoId = await p.makeVideo(postId);
    p.video(videoId)!.status = "final_qa";
    expect(await gateCrashed("visual", videoId, new Error("ffmpeg was killed"), p.store)).toBe(true);
    expect(p.video(videoId)).toMatchObject({ status: "team_review", error: GATE_CRASH_REASONS.visual });
    expect(w.postRow(postId)).toMatchObject({ status: "team_review", status_reason: GATE_CRASH_REASONS.visual });
    expect(await gateCrashed("visual", videoId, new Error("again"), p.store)).toBe(false);
  });

  it("Gate 5 re-render while all render slots are busy → render-video (waits for a slot) instead of poll-render", async () => {
    const w = world({ render5: async () => ({ status: "waiting" }) });
    const { postId, log } = await w.post(VISUAL_FIXTURE_TEXTS["face-glitch"]);
    expect(log).toEqual(["audio-qa", "edit-video", "technical-qa", "visual-qa", "render-video"]);
    const second = w.videosOf(postId)[1];
    expect(second).toMatchObject({ status: "queued", attempt: 2, counts_toward_plan: false });
  });

  it("Gate 5 re-render refused before any call (real HeyGen needs the admin's spend OK) → queued, post back to approved with the reason", async () => {
    const w = world({ render5: async () => { throw new PlainError("Real renders need an admin's OK."); } });
    const { postId, log } = await w.post(VISUAL_FIXTURE_TEXTS["face-glitch"]);
    expect(log).toEqual(["audio-qa", "edit-video", "technical-qa", "visual-qa"]);
    expect(w.postRow(postId).status).toBe("approved");
    expect(w.postRow(postId).status_reason).toMatch(/I agree to spend/);
    expect(w.videosOf(postId).map((x) => [x.status, x.counts_toward_plan])).toEqual([["failed", false], ["queued", false]]);
  });
});
