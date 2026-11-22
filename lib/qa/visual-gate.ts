import "server-only";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { logAdminError } from "@/lib/admin-errors";
import type { VisualQaOutput } from "@/lib/ai-schemas";
import type { CaptionStyleName } from "@/lib/captions";
import { ClaudeError } from "@/lib/claude";
import { runFfmpeg, type FfmpegRunner } from "@/lib/edit-flow";
import { confirmPlanSlot } from "@/lib/plan-slots";
import { PlainError } from "@/lib/plain-error";
import { TECH_QA, VISUAL_QA } from "@/lib/qa/config";
import { editManifestSchema, type EditManifest } from "@/lib/qa/edit-manifest";
import type { PipelineStore } from "@/lib/qa/pipeline-types";
import type { QaIssue } from "@/lib/qa/script-checks";
import type { RunTask } from "@/lib/qa/script-pipeline";
import { probeFinalJson } from "@/lib/qa/technical-gate";
import {
  BAND,
  HUMAN_REVIEW_TEXT,
  captionAt,
  classifyFix,
  faceZoneIssues,
  framePlan,
  humanReviewReasons,
  parsePgm,
  pixelIssues,
  rubricIssues,
  sampledForReview,
  type FrameKind,
  type GrayBand,
  type HumanReviewReason,
  type PlannedFrame,
} from "@/lib/qa/visual-checks";
import type { RenderStart } from "@/lib/render";

// Gate 5: Visual and realism QA (QA-SPEC), after Gate 4 passed (video + post 'final_qa').
//
//  1. Frames from the FINAL file (one ffmpeg pass): one every 2 s, the first and the last, one per
//     b-roll cut-in (lib/qa/visual-checks.ts framePlan). Each frame twice: a small JPEG for Claude and
//     a full-resolution gray strip across the top for the pixel checks.
//  2. Claude MAIN (visual_qa, image input, effort medium) with the QA-SPEC rubric (zod); each frame
//     goes with its time, kind and the caption line on screen. MOCK_CLAUDE: fixture answers.
//  3. Without AI: the AI label (when ai_label) and the trial tag (only and always when watermark) are
//     really drawn (pixels); the rubric's face box is inside our face-zone estimate.
//  4. ONE qa_reports row (gate 'visual', score = realism_score, issues with at_seconds, auto_fix =
//     the fix that made this video, as in Gates 3 and 4).
//  5. Passed → the QA-SPEC Gate 6 rules: the team watches it first (team_review = the QA queue, not
//     counted) or it is delivered (rpc deliver_post_video: ready, and this is the post's ONE counted video).
//     Failed, and the script has not used its one fix: captions/b-roll → re-edit once (back to
//     audio_qa; the edit runs again with a lower caption style / the clip swapped); face/realism →
//     re-render once (rpc create_visual_rerender, our cost, through renderVideo: spend guard, admin
//     OK in real mode). Anything else, or a second failure → team_review with the reason. Never
//     needs_you; never counted.

export type ExtractedFrame = { at_seconds: number; kind: FrameKind; jpeg: Uint8Array; band: GrayBand };

export type VisualGateDeps = {
  store: PipelineStore;
  files: { download(path: string): Promise<Uint8Array> };
  /** Claude tasks: runClaudeTask in the app (MOCK_CLAUDE by default), a mock in tests. */
  run: RunTask;
  /** Sends the one re-render through the normal render path (lib/render.ts renderVideo). */
  render: (videoId: string) => Promise<RenderStart>;
  /** Default: sampleFrames (ffprobe + one ffmpeg pass). */
  frames?: (file: string, manifest: EditManifest, workDir: string) => Promise<ExtractedFrame[]>;
  ffmpeg?: FfmpegRunner;
  probeJson?: (file: string) => Promise<string>;
  /** The random 1 in 5 for human review. Default: sampledForReview (stable per video id). */
  sample?: (videoId: string) => boolean;
  tmpRoot?: string;
};

export type VisualGateOutcome =
  | { status: "ready"; videoId: string }
  /** Passed, but a person watches it first (QA queue = team_review). */
  | { status: "queued"; videoId: string; reasons: HumanReviewReason[] }
  /** The one re-edit: the caller starts edit-video with these settings. */
  | { status: "reedit"; videoId: string; captionStyle: CaptionStyleName | null; avoidClips: string[] }
  /** videoId = the NEW video (the one automatic re-render). */
  | { status: "rerendering"; videoId: string; previousVideoId: string; render: RenderStart }
  | { status: "rerender_blocked"; videoId: string; reason: string }
  | { status: "team_review"; videoId: string; reason: string }
  | { status: "skipped"; videoId: string; why: string };

const LEAD = ["-nostdin", "-hide_banner", "-nostats", "-loglevel", "error"];

/** One pass: the planned frames (select by frame number) → small JPEGs + full-width gray top strips. Nothing else is written. */
export function frameExtractArgs(input: { file: string; frames: PlannedFrame[]; outDir: string; width: number }): string[] {
  for (const p of [input.file, input.outDir]) if (!path.isAbsolute(p)) throw new Error("Frame extraction needs absolute paths.");
  if (input.frames.length === 0) throw new Error("No frames to extract.");
  const select = input.frames.map((f) => `eq(n\\,${f.n})`).join("+");
  return [
    ...LEAD, "-i", input.file,
    "-filter_complex",
    `[0:v]select=${select},split=2[s1][s2];[s1]scale=${VISUAL_QA.claude_frame_width}:-2[c];[s2]crop=${input.width}:${BAND.height}:0:${BAND.y},format=gray[g]`,
    "-map", "[c]", "-fps_mode", "passthrough", "-q:v", "4", path.join(input.outDir, "c-%03d.jpg"),
    "-map", "[g]", "-fps_mode", "passthrough", path.join(input.outDir, "g-%03d.pgm"),
  ];
}

/** Frame count, fps, length and width of the final file (ffprobe JSON). */
export function parseFrameProbe(json: string): { frameCount: number; fps: number; durationS: number; width: number } {
  const data = JSON.parse(json) as { streams?: Record<string, unknown>[]; format?: { duration?: string } };
  const v = data.streams?.find((s) => s.codec_type === "video") ?? {};
  const [num, den] = String(v.avg_frame_rate ?? v.r_frame_rate ?? "0/1").split("/").map(Number);
  const fps = den ? num / den : 0;
  const durationS = Number(v.duration ?? data.format?.duration ?? 0);
  const frames = Number(v.nb_frames);
  const frameCount = Number.isFinite(frames) && frames > 0 ? frames : Math.round(durationS * fps);
  if (!(fps > 0) || !(frameCount > 0)) throw new Error("ffprobe found no video frames");
  return { frameCount, fps, durationS, width: Number(v.width ?? TECH_QA.width) || TECH_QA.width };
}

/** The real sampler: ffprobe, framePlan, one ffmpeg pass, the files read back in order. */
export async function sampleFrames(
  file: string,
  manifest: EditManifest,
  workDir: string,
  deps: { ffmpeg?: FfmpegRunner; probeJson?: (file: string) => Promise<string> } = {},
): Promise<ExtractedFrame[]> {
  const probe = parseFrameProbe(await (deps.probeJson ?? probeFinalJson)(file));
  const plan = framePlan({ durationS: probe.durationS, frameCount: probe.frameCount, fps: probe.fps, broll: manifest.broll });
  const outDir = path.join(workDir, "frames");
  await mkdir(outDir, { recursive: true });
  await (deps.ffmpeg ?? runFfmpeg)(frameExtractArgs({ file, frames: plan, outDir, width: probe.width }), { timeoutS: VISUAL_QA.extract_timeout_s });
  const names = (await readdir(outDir)).sort();
  const jpgs = names.filter((n) => n.startsWith("c-"));
  const pgms = names.filter((n) => n.startsWith("g-"));
  const count = Math.min(jpgs.length, pgms.length, plan.length);
  if (count === 0) throw new Error("ffmpeg extracted no frames");
  const frames: ExtractedFrame[] = [];
  for (let i = 0; i < count; i++) {
    frames.push({
      at_seconds: plan[i].at_seconds,
      kind: plan[i].kind,
      jpeg: new Uint8Array(await readFile(path.join(outDir, jpgs[i]))),
      band: parsePgm(new Uint8Array(await readFile(path.join(outDir, pgms[i]))), BAND.y),
    });
  }
  return frames;
}

const hard = (code: string, detail: string): QaIssue => ({ code, detail, at_seconds: null, severity: "hard" });

/**
 * p5-b4 (QA-SPEC Gate 6): did this script's video pass Gate 5 only after an automatic fix? Any failed
 * Gate 3 (→ one re-render), Gate 4 (→ one rebuild) or Gate 5 (→ one re-edit / re-render) report for
 * the script means yes. Per script on purpose: a re-render is a new video row of the same script. A
 * video re-made after a Gate 6 reject of the same script also counts (a person watches the redo).
 */
async function passedAfterAutoFix(scriptId: string, visualFailures: number, store: PipelineStore): Promise<boolean> {
  if (visualFailures > 0) return true;
  if ((await store.countFailedScriptReports(scriptId, "audio")) > 0) return true;
  return (await store.countFailedScriptReports(scriptId, "technical")) > 0;
}

export async function runVisualGate(videoId: string, deps: VisualGateDeps): Promise<VisualGateOutcome> {
  const ctx = await deps.store.getGateContext(videoId);
  if (!ctx) throw new PlainError("Video not found.");
  const { video, script, brand } = ctx;
  if (video.kind !== "post") throw new PlainError("Only post videos go through the visual check.");
  if (video.status !== "final_qa") return { status: "skipped", videoId, why: `it is ${video.status}` };
  if (!video.final_path) throw new PlainError("The video has no final file yet.");
  const failedBefore = await deps.store.countFailedScriptReports(script.id, "visual");

  const parsedManifest = editManifestSchema.safeParse(video.edit_manifest);
  const manifest = parsedManifest.success ? parsedManifest.data : null;
  let issues: QaIssue[] = [];
  let answer: VisualQaOutput | null = null;
  if (!manifest) {
    issues = [hard("no_manifest", "The edit did not record what it built (edit_manifest), so it can't be checked.")];
  } else {
    const workDir = await mkdtemp(path.join(deps.tmpRoot ?? os.tmpdir(), "visual-qa-"));
    try {
      const finalFile = path.join(workDir, "final.mp4");
      await writeFile(finalFile, await deps.files.download(video.final_path));
      const frames = await (deps.frames ?? ((f, m, w) => sampleFrames(f, m, w, deps)))(finalFile, manifest, workDir);
      try {
        answer = await deps.run("visual_qa", {
          brand,
          input: {
            language: brand.language,
            display_text: script.display_text,
            caption_style: manifest.caption_style,
            frames: frames.map((f, index) => ({ index, at_seconds: f.at_seconds, kind: f.kind, caption: captionAt(manifest, f.at_seconds) })),
          },
          images: frames.map((f) => ({ mediaType: "image/jpeg" as const, data: Buffer.from(f.jpeg).toString("base64") })),
        });
      } catch (error) {
        if (!(error instanceof ClaudeError)) throw error;
        // Fail safe: without the judgement nothing reaches the customer; the team looks.
        issues.push(hard("visual_judge_failed", `Couldn't get the visual check (${error.message}). The team must watch the video.`));
      }
      if (answer) issues.push(...rubricIssues(answer, frames), ...faceZoneIssues({ face: answer.face_box, watermark: video.watermark }));
      issues.push(...pixelIssues({ frames, aiLabel: video.ai_label, watermark: video.watermark }));
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  const passed = issues.every((i) => i.severity !== "hard");
  const score = answer?.realism_score ?? null;
  await deps.store.insertQaReport({
    video_id: video.id,
    script_id: script.id,
    gate: "visual",
    passed,
    score,
    issues,
    auto_fix: failedBefore > 0 ? video.qa_fix_note : null,
  });

  const toTeam = async (reason: string): Promise<VisualGateOutcome> => {
    const text = reason.slice(0, 1000);
    // As Gates 3 and 4 (p5-b1 NICE 6): the post follows only when THIS run moved the video.
    if (!(await deps.store.moveVideo(video.id, "team_review", ["final_qa"], text))) return { status: "skipped", videoId: video.id, why: "it moved on" };
    await deps.store.setPostStatus(video.post_id, "team_review", text);
    return { status: "team_review", videoId: video.id, reason: text };
  };

  if (passed) {
    // QA-SPEC Gate 6: which passed videos a person watches before the customer.
    const reasons = humanReviewReasons({
      priorPosts: await deps.store.countBrandPostsPassed(video.brand_id, "visual", video.post_id),
      realism: score ?? 0,
      managed: brand.is_managed,
      teamReviewsEveryVideo: brand.is_managed ? await deps.store.teamReviewsEveryVideo(video.brand_id) : false,
      sampled: (deps.sample ?? sampledForReview)(video.id),
      autoFixed: await passedAfterAutoFix(script.id, failedBefore, deps.store),
    });
    if (reasons.length > 0) {
      const out = await toTeam(reasons.map((r) => HUMAN_REVIEW_TEXT[r]).join(" "));
      return out.status === "team_review" ? { status: "queued", videoId: video.id, reasons } : out;
    }
    const delivered = await deps.store.deliverVideo(video.id);
    if (delivered !== "delivered") return { status: "skipped", videoId: video.id, why: `deliver answered ${delivered}` };
    await confirmPlanSlot({ id: video.id, brand_id: video.brand_id });
    return { status: "ready", videoId: video.id };
  }

  const problems = issues.filter((i) => i.severity === "hard").map((i) => i.detail).join(" ");
  const fix = manifest && failedBefore < VISUAL_QA.max_fixes ? classifyFix(issues, manifest) : ({ kind: "team" } as const);
  const teamReason = `Visual check failed${failedBefore > 0 ? " after one automatic fix" : ""}: ${problems}`;
  if (fix.kind === "team") return toTeam(teamReason);

  if (fix.kind === "reedit") {
    const reason = `Visual check failed; re-editing once: ${problems}`.slice(0, 1000);
    if (!(await deps.store.prepareReedit(video.id, fix.note, reason))) return { status: "skipped", videoId: video.id, why: "it moved on" };
    await deps.store.setPostStatus(video.post_id, "editing", null);
    return { status: "reedit", videoId: video.id, captionStyle: fix.captionStyle, avoidClips: fix.avoidClips };
  }

  const made = await deps.store.createVisualRerender(video.id, fix.note);
  if (made.outcome !== "created" || !made.videoId) return toTeam(teamReason);
  try {
    const render = await deps.render(made.videoId);
    return { status: "rerendering", videoId: made.videoId, previousVideoId: video.id, render };
  } catch (error) {
    // As Gate 3: nothing was sent (no spend OK, paused, daily cap). The re-render stays queued and the
    // post goes back to approved, so "Make video" finds it and the admin renders it with "I agree to spend".
    logAdminError("[visual-qa] the re-render was made but not sent", { videoId: made.videoId }, error);
    const why = error instanceof PlainError ? error.message : "The render could not be started.";
    const reason = `Visual check: one re-render (our cost) is queued but was not sent. ${why} A real render needs an admin's OK: press Make video and tick “I agree to spend”.`.slice(0, 1000);
    await deps.store.setPostStatus(video.post_id, "approved", reason);
    return { status: "rerender_blocked", videoId: made.videoId, reason };
  }
}
