import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeError, runClaudeTask, type ClaudeContext, type ClaudeTaskName } from "@/lib/claude";
import type { EditManifest } from "@/lib/qa/edit-manifest";
import { HUMAN_REVIEW_TEXT } from "@/lib/qa/visual-checks";
import { runVisualGate, type VisualGateDeps } from "@/lib/qa/visual-gate";
import { VISUAL_FIXTURE_TEXTS } from "@/lib/qa/visual-mock";
import { transcriptFor } from "@/tests/helpers/edit-real";
import { memoryPipeline } from "@/tests/helpers/pipeline-memory";
import { fakeFrames } from "@/tests/helpers/visual-frames";

// p5-b2: Gate 5 (visual and realism QA) on the in-memory pipeline. Claude = the MOCK_CLAUDE path
// (fixtures chosen by display text); frames are injected (the real ffmpeg sampler has its own
// integration test). One qa_reports row per run; one automatic fix per script; the rest → team.

const GOOD_TEXT = "Hi, I'm Ayesha from Bright Smile Dental. Brush twice a day and floss once. Book your free check-up today.";
const HOOK = "Hi, I'm Ayesha from Bright Smile Dental.";
const CTA = "Book your free check-up today.";

const manifestFor = (style: EditManifest["caption_style"] = "big_words", over: Partial<EditManifest> = {}): EditManifest => ({
  version: 1, raw_duration_s: 7.8, format: "talking", caption_style: style, avoid_clips: [],
  captions: [{ start_s: 0.2, end_s: 2.2, scale: 1, lines: [[{ text: "Hi,", start_s: 0.2, end_s: 0.5, source: "matched", stt_indexes: [0] }]] }],
  broll: [{ start_s: 3, duration_s: 2, clip: "clip-coffee" }], protected: { hook_end_s: 2, cta_start_s: 6 },
  music: null, ai_label: true, watermark: false, not_applied: [], ...over,
});

const run = <T extends ClaudeTaskName>(task: T, ctx: ClaudeContext<T>) => runClaudeTask(task, ctx, { logUsage: async () => {} });
let tmpRoot: string;

beforeEach(async () => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network is not allowed in tests"));
  for (const name of ["MOCK_HEYGEN", "MOCK_STT", "MOCK_CLAUDE", "MOCK_PEXELS"]) vi.stubEnv(name, "");
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "visual-gate-"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** A post video that passed Gate 4: final_qa, final file in the bucket, manifest, edit run. */
async function finalQa(text = GOOD_TEXT, opts: { style?: EditManifest["caption_style"]; watermark?: boolean; managed?: boolean; priorPosts?: number } = {}) {
  const p = memoryPipeline();
  p.brandInfo.is_managed = opts.managed ?? false;
  const { postId, scriptId } = await p.seedPost({ displayText: text, hook: HOOK, cta: CTA });
  const videoId = await p.makeVideo(postId);
  const e = p.extra(p.video(videoId)!);
  e.transcript = transcriptFor(text, 7.6);
  e.watermark = opts.watermark ?? false;
  e.final_path = `final/b/${videoId}/runs/run_1.mp4`;
  e.edit_run_id = "run_1";
  e.edit_manifest = manifestFor(opts.style, { watermark: e.watermark });
  await p.files.upload(e.final_path, new Uint8Array([1, 2, 3]), "video/mp4");
  p.video(videoId)!.status = "final_qa";
  p.v.posts[0].status = "final_qa";
  const prior = opts.priorPosts ?? 5;
  const realCount = p.store.countBrandPostsPassed;
  p.store.countBrandPostsPassed = async (...args) => prior + (await realCount(...args));
  const deps = (over: Partial<VisualGateDeps> = {}): VisualGateDeps => ({
    store: p.store, files: p.files, run, render: p.render, tmpRoot, sample: () => false,
    frames: async () => {
      const row = await p.store.getGateContext(p.v.videos.at(-1)!.id);
      return fakeFrames(row!.video.edit_manifest as EditManifest, { aiLabel: row!.video.ai_label, watermark: row!.video.watermark });
    },
    ...over,
  });
  return { p, postId, scriptId, videoId, deps };
}

describe("Gate 5 passes → delivered (ready, counts) or the QA queue", () => {
  it("all good, an established self-serve brand, not sampled → video + post ready; ONLY this video counts; one visual report", async () => {
    const { p, videoId, deps } = await finalQa();
    const out = await runVisualGate(videoId, deps());
    expect(out.status).toBe("ready");
    expect(p.video(videoId)).toMatchObject({ status: "ready", counts_toward_plan: true });
    expect(p.v.posts[0]).toMatchObject({ status: "ready", status_reason: null });
    expect(p.reports.map((r) => [r.gate, r.passed, r.score, r.auto_fix])).toEqual([["visual", true, 9, null]]);
  });

  it("one of the brand's first 5 videos → team_review (QA queue) with the reason, NOT counted", async () => {
    const { p, videoId, deps } = await finalQa(GOOD_TEXT, { priorPosts: 4 });
    const out = await runVisualGate(videoId, deps());
    expect(out).toMatchObject({ status: "queued", reasons: ["first_videos"] });
    expect(p.video(videoId)).toMatchObject({ status: "team_review", counts_toward_plan: false });
    expect(p.v.posts[0]).toMatchObject({ status: "team_review", status_reason: HUMAN_REVIEW_TEXT.first_videos });
  });

  it("realism 8 passes Gate 5 but goes to the queue (under 9); a managed brand → queue until switched off; random sample → queue", async () => {
    const low = await finalQa(VISUAL_FIXTURE_TEXTS["realism-8"]);
    expect(await runVisualGate(low.videoId, low.deps())).toMatchObject({ status: "queued", reasons: ["realism_margin"] });
    expect(low.p.reports[0]).toMatchObject({ passed: true, score: 8 });

    const managed = await finalQa(GOOD_TEXT, { managed: true });
    expect(await runVisualGate(managed.videoId, managed.deps())).toMatchObject({ status: "queued", reasons: ["managed"] });
    const off = await finalQa(GOOD_TEXT, { managed: true });
    off.p.brandQaSettings.set(off.p.v.brands[0].id, false);
    expect((await runVisualGate(off.videoId, off.deps())).status).toBe("ready");

    const sampled = await finalQa();
    expect(await runVisualGate(sampled.videoId, sampled.deps({ sample: () => true }))).toMatchObject({ status: "queued", reasons: ["random"] });
  });
});

describe("Gate 5 fails → ONE automatic fix per QA-SPEC, never counted", () => {
  it("captions over the mouth → report #1 failed (captions_over_face, at_seconds) → video back to audio_qa, post editing, re-edit with small_box", async () => {
    const { p, videoId, deps } = await finalQa(VISUAL_FIXTURE_TEXTS["captions-over-mouth"]);
    const out = await runVisualGate(videoId, deps());
    expect(out).toMatchObject({ status: "reedit", captionStyle: "small_box", avoidClips: [] });
    expect(p.reports[0]).toMatchObject({ gate: "visual", passed: false, auto_fix: null });
    expect(p.reports[0].issues.find((i) => i.code === "captions_over_face")).toMatchObject({ severity: "hard", at_seconds: 2 });
    expect(p.video(videoId)).toMatchObject({ status: "audio_qa", counts_toward_plan: false });
    expect(p.extra(p.video(videoId)!).qa_fix_note).toMatch(/re-edited once.*small_box/);
    expect(p.v.posts[0].status).toBe("editing");
  });

  it("a face glitch → re-render once through renderVideo (mock HeyGen, spend guard) → new attempt, counts_toward_plan false", async () => {
    const { p, videoId, deps } = await finalQa(VISUAL_FIXTURE_TEXTS["face-glitch"]);
    const out = await runVisualGate(videoId, deps());
    expect(out.status).toBe("rerendering");
    const second = (out as { videoId: string }).videoId;
    expect(p.video(videoId)).toMatchObject({ status: "failed", counts_toward_plan: false });
    expect(p.video(second)).toMatchObject({ status: "rendering", attempt: 2, counts_toward_plan: false });
    expect(p.extra(p.video(second)!)).toMatchObject({ rerender_gate: "visual", rerender_of: videoId });
    expect(p.spend.rows.every((r) => r.mock === true)).toBe(true);
  });

  it("a second failure for the same script (after its one fix) → team_review with the reason; auto_fix names the fix", async () => {
    const { p, videoId, deps } = await finalQa(VISUAL_FIXTURE_TEXTS["captions-over-mouth"]);
    await runVisualGate(videoId, deps());
    // The re-edit happened but (say) kept big_words: back in final_qa, Gate 5 again.
    p.video(videoId)!.status = "final_qa";
    const out = await runVisualGate(videoId, deps());
    expect(out.status).toBe("team_review");
    expect(p.reports.map((r) => [r.passed, r.auto_fix?.slice(0, 24) ?? null])).toEqual([
      [false, null],
      [false, "Gate 5: re-edited once: "],
    ]);
    expect(p.video(videoId)).toMatchObject({ status: "team_review", counts_toward_plan: false });
    expect(p.v.posts[0].status).toBe("team_review");
    expect(p.v.posts[0].status_reason).toMatch(/after one automatic fix/);
  });

  it("face below the face zone → team_review at once (face_zone_estimate, plain team reason), never auto-fixed", async () => {
    const { p, videoId, deps } = await finalQa(VISUAL_FIXTURE_TEXTS["face-too-low"], { watermark: true });
    const out = await runVisualGate(videoId, deps());
    expect(out.status).toBe("team_review");
    expect(p.reports[0].issues.map((i) => i.code)).toContain("face_zone_estimate");
    expect(p.v.posts[0].status_reason).toMatch(/face-zone estimate is wrong/);
    expect(p.v.videos.length).toBe(1); // no re-render, no re-edit
  });

  it("pixel checks: the label not really drawn (ai_label on) → team; a trial tag on a paid video → team", async () => {
    const a = await finalQa();
    const noLabel = await runVisualGate(a.videoId, a.deps({ frames: async () => fakeFrames(manifestFor(), { aiLabel: false, watermark: false }) }));
    expect(noLabel.status).toBe("team_review");
    expect(a.p.reports[0].issues.map((i) => i.code)).toEqual(["label_missing"]);

    const b = await finalQa();
    const tagged = await runVisualGate(b.videoId, b.deps({ frames: async () => fakeFrames(manifestFor(), { aiLabel: true, watermark: true }) }));
    expect(tagged.status).toBe("team_review");
    expect(b.p.reports[0].issues.map((i) => i.code)).toEqual(["watermark_unexpected"]);
  });

  it("Claude can't answer → fail safe: team_review (visual_judge_failed), nothing delivered", async () => {
    const { p, videoId, deps } = await finalQa();
    const busy = (async () => {
      throw new ClaudeError("busy", "Claude is busy right now.");
    }) as VisualGateDeps["run"];
    expect((await runVisualGate(videoId, deps({ run: busy }))).status).toBe("team_review");
    expect(p.reports[0]).toMatchObject({ passed: false, score: null });
    expect(p.reports[0].issues.map((i) => i.code)).toEqual(["visual_judge_failed"]);
    expect(p.video(videoId)?.counts_toward_plan).toBe(false);
  });

  it("only a final_qa post video is checked; anything else is skipped and nothing is written", async () => {
    const { p, videoId, deps } = await finalQa();
    p.video(videoId)!.status = "editing";
    expect((await runVisualGate(videoId, deps())).status).toBe("skipped");
    expect(p.reports).toEqual([]);
  });

  it("sends Claude MAIN the frames as images, each with its time, kind and caption line", async () => {
    const { videoId, deps } = await finalQa();
    const seen: { input: unknown; images: number }[] = [];
    const spy = (async (task: ClaudeTaskName, ctx: ClaudeContext<"visual_qa">) => {
      seen.push({ input: ctx.input, images: ctx.images?.length ?? 0 });
      return run(task as "visual_qa", ctx);
    }) as VisualGateDeps["run"];
    await runVisualGate(videoId, deps({ run: spy }));
    const input = seen[0].input as { caption_style: string; frames: { index: number; at_seconds: number; kind: string; caption: string }[] };
    expect(input.caption_style).toBe("big_words");
    expect(seen[0].images).toBe(input.frames.length);
    expect(input.frames.slice(0, 2)).toEqual([
      { index: 0, at_seconds: 0, kind: "first", caption: "" },
      { index: 1, at_seconds: 2, kind: "every_2s", caption: "Hi," },
    ]);
  });
});
