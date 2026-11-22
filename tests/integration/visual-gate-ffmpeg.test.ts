import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runClaudeTask, type ClaudeContext, type ClaudeTaskName } from "@/lib/claude";
import { editManifestSchema, type EditManifest } from "@/lib/qa/edit-manifest";
import { framePlan, overlayDrawn, overlayRegions, pixelIssues } from "@/lib/qa/visual-checks";
import { runVisualGate, sampleFrames } from "@/lib/qa/visual-gate";
import { editForReal, transcriptFor } from "@/tests/helpers/edit-real";
import { hasFfmpeg, makeTalkingInput } from "@/tests/helpers/ffmpeg-local";
import { memoryPipeline } from "@/tests/helpers/pipeline-memory";

// p5-b2: Gate 5 with the REAL local ffmpeg. The editor makes three reels from the same talking-head
// stand-in (label + trial tag, label only, neither); the real sampler pulls the QA-SPEC frames in one
// ffmpeg pass; the pixel checks (no AI) must see exactly what was drawn. Then one whole Gate 5 run on
// a real file (MOCK_CLAUDE answer). Local programs only: no network, nothing paid.

const FFMPEG = hasFfmpeg();
const DISPLAY = "Hi, I'm Ayesha from Bright Smile Dental. Brush twice a day and floss once. Book your free check-up today.";
const HOOK = "Hi, I'm Ayesha from Bright Smile Dental.";
const CTA = "Book your free check-up today.";
const EDIT_PLAN = { broll_moments: [{ at_words: "Brush twice a day", keyword: "toothbrush" }], emphasis_words: [] };

let root: string;
const made: Record<string, { file: string; manifest: EditManifest }> = {};

beforeAll(async () => {
  if (!FFMPEG) return;
  root = await mkdtemp(path.join(os.tmpdir(), "p5b2-gate5-"));
  const raw = path.join(root, "raw.mp4");
  makeTalkingInput(raw, 8);
  for (const [name, row] of Object.entries({
    trial: { ai_label: true, watermark: true },
    label: { ai_label: true, watermark: false },
    none: { ai_label: false, watermark: false },
  })) {
    const out = path.join(root, `${name}.mp4`);
    const { outcome, row: saved } = await editForReal({
      rawFile: raw, outFile: out, tmpRoot: root, row,
      job: { displayText: DISPLAY, editPlan: EDIT_PLAN, hook: HOOK, cta: CTA, transcript: transcriptFor(DISPLAY, 8), format: "talking", aiLabel: row.ai_label, watermark: row.watermark },
    });
    expect(["edited", "needs_team"]).toContain(outcome.status);
    made[name] = { file: out, manifest: editManifestSchema.parse((saved as Record<string, unknown>).edit_manifest) };
  }
}, 120_000);

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe.skipIf(!FFMPEG)("Gate 5 frames + pixel checks with the real ffmpeg", () => {
  it("samples exactly the QA-SPEC frames (every 2 s, first, last, one per b-roll cut): JPEGs for Claude + gray strips", async () => {
    const work = await mkdtemp(path.join(root, "frames-"));
    const { file, manifest } = made.label;
    const frames = await sampleFrames(file, manifest, work);
    const plan = framePlan({ durationS: 8, frameCount: 240, fps: 30, broll: manifest.broll });
    expect(frames.map((f) => [f.at_seconds, f.kind])).toEqual(plan.map((f) => [f.at_seconds, f.kind]));
    expect(frames[0].kind).toBe("first");
    expect(frames.at(-1)!.kind).toBe("last");
    expect(frames.filter((f) => f.kind === "broll").length).toBe(manifest.broll.length);
    for (const f of frames) {
      expect([...f.jpeg.subarray(0, 2)]).toEqual([0xff, 0xd8]);
      expect({ width: f.band.width, height: f.band.height }).toEqual({ width: 1080, height: 80 });
    }
  }, 60_000);

  it("the AI label and the trial tag are seen exactly where they were drawn (and not where they were not)", async () => {
    const r = overlayRegions();
    const seen: Record<string, { label: string[]; tag: string[] }> = {};
    for (const name of ["trial", "label", "none"]) {
      const frames = await sampleFrames(made[name].file, made[name].manifest, await mkdtemp(path.join(root, `px-${name}-`)));
      seen[name] = { label: frames.map((f) => overlayDrawn(f.band, r.label)), tag: frames.map((f) => overlayDrawn(f.band, r.tag)) };
    }
    // Present = never "absent" and seen at least once; absent = never "drawn" and confirmed at least once.
    // ("unknown" = a frame too dark to tell, e.g. a dark stock clip under the box.)
    const state = (xs: string[]) =>
      xs.includes("drawn") && !xs.includes("absent") ? "present" : xs.includes("absent") && !xs.includes("drawn") ? "absent" : `mixed:${xs.join(",")}`;
    expect({
      trialLabel: state(seen.trial.label), trialTag: state(seen.trial.tag),
      labelLabel: state(seen.label.label), labelTag: state(seen.label.tag),
      noneLabel: state(seen.none.label), noneTag: state(seen.none.tag),
    }).toEqual({ trialLabel: "present", trialTag: "present", labelLabel: "present", labelTag: "absent", noneLabel: "absent", noneTag: "absent" });
    // The talking-head frames (flat face colour) are all decided; only b-roll frames may be unknown.
    const faceFrames = seen.label.label.filter((_, i) => i !== 0);
    expect(faceFrames.filter((s) => s === "drawn").length).toBeGreaterThan(faceFrames.length / 2);

    // As issues: a label-less file for an ai_label video, a trial file for a paid video.
    const none = await sampleFrames(made.none.file, made.none.manifest, await mkdtemp(path.join(root, "iss-")));
    expect(pixelIssues({ frames: none, aiLabel: true, watermark: false }).map((i) => i.code)).toEqual(["label_missing"]);
    const trial = await sampleFrames(made.trial.file, made.trial.manifest, await mkdtemp(path.join(root, "iss2-")));
    expect(pixelIssues({ frames: trial, aiLabel: true, watermark: false }).map((i) => i.code)).toEqual(["watermark_unexpected"]);
    expect(pixelIssues({ frames: trial, aiLabel: true, watermark: true })).toEqual([]);
  }, 60_000);

  it("a whole Gate 5 run on a real file (real sampler, MOCK_CLAUDE) → passed and delivered", async () => {
    vi.stubEnv("MOCK_CLAUDE", "");
    const p = memoryPipeline();
    p.brandInfo.is_managed = false;
    const { postId } = await p.seedPost({ displayText: DISPLAY, hook: HOOK, cta: CTA });
    const videoId = await p.makeVideo(postId);
    const e = p.extra(p.video(videoId)!);
    Object.assign(e, { final_path: "final/real.mp4", edit_manifest: made.label.manifest, watermark: false, ai_label: true });
    await p.files.upload("final/real.mp4", new Uint8Array(await readFile(made.label.file)), "video/mp4");
    p.video(videoId)!.status = "final_qa";
    p.store.countBrandPostsPassed = async () => 5;
    const run = <T extends ClaudeTaskName>(task: T, ctx: ClaudeContext<T>) => runClaudeTask(task, ctx, { logUsage: async () => {} });
    const out = await runVisualGate(videoId, { store: p.store, files: p.files, run, render: p.render, sample: () => false, tmpRoot: root });
    expect(out.status).toBe("ready");
    expect(p.reports[0]).toMatchObject({ gate: "visual", passed: true, score: 9, issues: [] });
    vi.unstubAllEnvs();
  }, 60_000);
});
