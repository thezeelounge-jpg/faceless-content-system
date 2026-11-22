import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BrollProvider } from "@/lib/broll";
import type { GateContext, PipelineStore, VideoQaReport } from "@/lib/qa/pipeline-types";
import { editManifestSchema } from "@/lib/qa/edit-manifest";
import { runTechnicalGate } from "@/lib/qa/technical-gate";
import { REAL_BRAND, REAL_RAW, REAL_VIDEO, editForReal, transcriptFor } from "@/tests/helpers/edit-real";
import { hasFfmpeg, makeBadFinal, makeMovingTalkingInput } from "@/tests/helpers/ffmpeg-local";

// p5-a2: Gate 4 with the REAL local ffmpeg/ffprobe. The editor (runEditJob) makes a reel from a
// MOVING 10 s stand-in (testsrc2: freezedetect needs motion; the flat-colour fixtures are frozen
// by design), with b-roll (MOCK_PEXELS clips), music (fixture beds), captions, AI label. Gate 4 then
// measures it for real: ffprobe, box order, blackdetect + freezedetect + ebur128, the voice and
// music stems. A deliberately bad file (25 fps, black, frozen, quiet, no +faststart) fails, is sent
// back for ONE rebuild, then goes to the team. Local programs only: no network, nothing paid.

const FFMPEG = hasFfmpeg();
const POST = "20000000-0000-4000-8000-0000000000b2";
const SCRIPT = "30000000-0000-4000-8000-0000000000b2";
const DISPLAY = "Stop scrolling now. Here is how small cafes grow on WhatsApp every week with one simple message. Book a free call today.";
const HOOK = "Stop scrolling now.";
const CTA = "Book a free call today.";
const EDIT_PLAN = {
  broll_moments: [
    { at_words: "small cafes grow", keyword: "coffee shop" },
    { at_words: "with one simple", keyword: "phone" },
  ],
  emphasis_words: ["WhatsApp"],
};
const TRANSCRIPT = transcriptFor(DISPLAY, 10);

let root: string;
let rawFile: string;
let goodFile: string;
let badFile: string;
let manifest: unknown;

beforeAll(async () => {
  if (!FFMPEG) return;
  root = await mkdtemp(path.join(os.tmpdir(), "p5a2-gate4-"));
  rawFile = path.join(root, "raw.mp4");
  goodFile = path.join(root, "final.mp4");
  badFile = path.join(root, "bad.mp4");
  makeMovingTalkingInput(rawFile, 10);
  makeBadFinal(badFile);
  // The MOCK_PEXELS fixture clips are flat colours (still by design), so a 2.4 s cut would be a
  // real 2.4 s freeze. Real stock clips move: this test uses a moving b-roll clip instead.
  const movingClip = path.join(root, "broll-moving.mp4");
  makeMovingTalkingInput(movingClip, 4);
  const broll: BrollProvider = {
    search: async (keyword) => [{ id: "moving", keyword, file: movingClip, width: 540, height: 960, duration_s: 4, source: "mock" }],
  };
  const { outcome, row } = await editForReal({
    rawFile,
    outFile: goodFile,
    tmpRoot: root,
    broll,
    job: { displayText: DISPLAY, editPlan: EDIT_PLAN, hook: HOOK, cta: CTA, transcript: TRANSCRIPT, format: "story", captionStyle: "big_words" },
  });
  expect(outcome.status).toBe("edited");
  manifest = (row as Record<string, unknown>).edit_manifest;
}, 60_000);

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

/** One video, as Gate 4 sees it; the store records what the gate writes. */
function oneVideo(finalPath: string) {
  const reports: VideoQaReport[] = [];
  const posts: { status: string; reason: string | null }[] = [];
  const ctx: GateContext = {
    video: {
      id: REAL_VIDEO, brand_id: REAL_BRAND, post_id: POST, script_id: SCRIPT, kind: "post", status: "final_qa", attempt: 1,
      raw_path: REAL_RAW, final_path: finalPath, duration_s: 10, transcript: TRANSCRIPT, ai_label: true, watermark: false,
      counts_toward_plan: false, edit_manifest: manifest, qa_fix_note: null, edit_run_id: null,
    },
    script: { id: SCRIPT, post_id: POST, display_text: DISPLAY, spoken_text: DISPLAY, hook: HOOK, cta: CTA, est_seconds: 10, edit_plan: EDIT_PLAN, broll_keywords: [] },
    post: { id: POST, status: "final_qa", format: "story" },
    brand: {
      id: REAL_BRAND, name: "Cafe Growth", niche: null, audience: null, offers: null, tone: null, sound_answers: {}, samples: null, banned_words: [],
      language: "en", profile_md: null, pillars: [], words_per_second: 2.4, is_managed: true, autopilot_level: "review_everything",
    },
    personName: null,
    dictionary: [{ written: "WhatsApp", say_as: "whats app", status: "approved" }],
    maxSeconds: 60,
  };
  const store: PipelineStore = {
    getGateContext: async () => structuredClone(ctx),
    moveVideo: async (_id, to, from) => (from.includes(ctx.video.status) ? ((ctx.video.status = to), true) : false),
    setPostStatus: async (_id, status, reason) => void posts.push({ status, reason }),
    saveTranscript: async () => {},
    insertQaReport: async (row) => void reports.push(row),
    countFailedReports: async (_id, gate) => reports.filter((r) => r.gate === gate && !r.passed).length,
    saveQaRespelling: async () => {},
    updateSpokenText: async () => {},
    createQaRerender: async () => ({ outcome: "not_allowed", videoId: null }),
    // p5-b2: Gate 5 methods (not used by Gate 4).
    countFailedScriptReports: async () => 0,
    countBrandPostsPassed: async () => 0,
    teamReviewsEveryVideo: async () => true,
    prepareReedit: async () => false,
    createVisualRerender: async () => ({ outcome: "not_allowed", videoId: null }),
    deliverVideo: async () => "not_allowed",
  };
  const files = {
    download: async (p: string) => new Uint8Array(await readFile(p === REAL_RAW ? rawFile : p === "final/good.mp4" ? goodFile : badFile)),
  };
  return { ctx, store, files, reports, posts };
}

describe.skipIf(!FFMPEG)("Gate 4 with the real ffmpeg", () => {
  it("the editor records its manifest; the real edit passes every technical check", async () => {
    expect(editManifestSchema.parse(manifest).broll.length).toBeGreaterThan(0);
    const v = oneVideo("final/good.mp4");
    const out = await runTechnicalGate(REAL_VIDEO, { store: v.store, files: v.files, tmpRoot: root });
    expect(v.reports[0].issues).toEqual([]);
    expect(out.status).toBe("passed");
    expect(v.reports[0].score).toBeGreaterThanOrEqual(-15.5);
    expect(v.reports[0].score).toBeLessThanOrEqual(-12.5);
    expect(v.ctx.video.status).toBe("final_qa");
  }, 30_000);

  it("a bad file (25 fps, black, frozen, quiet, no +faststart) fails with each problem, is rebuilt once, then goes to the team", async () => {
    const v = oneVideo("final/bad.mp4");
    const first = await runTechnicalGate(REAL_VIDEO, { store: v.store, files: v.files, tmpRoot: root });
    expect(first.status).toBe("rebuild");
    const codes = v.reports[0].issues.map((i) => i.code);
    for (const code of ["format", "faststart", "loudness", "black_frames", "frozen_frames"]) expect(codes).toContain(code);
    expect(v.reports[0].issues.find((i) => i.code === "black_frames")?.at_seconds).toBe(0);
    expect(v.reports[0].issues.find((i) => i.code === "frozen_frames")?.at_seconds).toBeLessThanOrEqual(1.1);
    expect(v.ctx.video.status).toBe("audio_qa");

    v.ctx.video.status = "final_qa"; // the rebuild made the same bad file again
    const second = await runTechnicalGate(REAL_VIDEO, { store: v.store, files: v.files, tmpRoot: root });
    expect(second.status).toBe("team_review");
    expect(v.reports[1].auto_fix).toBe("Rebuilt the edit once.");
    expect(v.ctx.video.status).toBe("team_review");
    expect(v.posts.at(-1)?.status).toBe("team_review");
  }, 30_000);
});
